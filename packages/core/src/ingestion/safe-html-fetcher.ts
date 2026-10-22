import { lookup } from "node:dns/promises";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Agent, fetch } from "undici";

const MAX_BYTES = 5 * 1024 * 1024;
const REDIRECT_LIMIT = 5;
type UndiciResponse = Awaited<ReturnType<typeof fetch>>;

const privateNetworkBlocks = new BlockList();
privateNetworkBlocks.addSubnet("0.0.0.0", 8, "ipv4");
privateNetworkBlocks.addSubnet("10.0.0.0", 8, "ipv4");
privateNetworkBlocks.addSubnet("100.64.0.0", 10, "ipv4");
privateNetworkBlocks.addSubnet("127.0.0.0", 8, "ipv4");
privateNetworkBlocks.addSubnet("169.254.0.0", 16, "ipv4");
privateNetworkBlocks.addSubnet("172.16.0.0", 12, "ipv4");
privateNetworkBlocks.addSubnet("192.168.0.0", 16, "ipv4");
privateNetworkBlocks.addSubnet("224.0.0.0", 4, "ipv4");
privateNetworkBlocks.addSubnet("240.0.0.0", 4, "ipv4");
// IPv4-compatible addresses (deprecated), including the unspecified and loopback addresses.
privateNetworkBlocks.addSubnet("::", 96, "ipv6");
privateNetworkBlocks.addSubnet("64:ff9b:1::", 48, "ipv6");
privateNetworkBlocks.addSubnet("100::", 64, "ipv6");
// Teredo hides the IPv4 address it tunnels to, so it cannot be checked.
privateNetworkBlocks.addSubnet("2001::", 32, "ipv6");
privateNetworkBlocks.addSubnet("fc00::", 7, "ipv6");
privateNetworkBlocks.addSubnet("fe80::", 10, "ipv6");
privateNetworkBlocks.addSubnet("ff00::", 8, "ipv6");

export interface PublicBytes {
  bytes: Uint8Array;
  contentType: string;
  finalUrl: string;
}

export async function fetchPublicHtml(input: string): Promise<{ html: string; finalUrl: string }> {
  const result = await fetchPublicBytes(input, {
    accept: "text/html,application/xhtml+xml",
    maxBytes: MAX_BYTES,
  });
  if (
    !result.contentType.includes("text/html") &&
    !result.contentType.includes("application/xhtml+xml")
  ) {
    throw new Error(`Unsupported source content type: ${result.contentType || "unknown"}`);
  }
  return { html: new TextDecoder().decode(result.bytes), finalUrl: result.finalUrl };
}

export async function fetchPublicBytes(
  input: string,
  options: { accept: string; maxBytes: number },
): Promise<PublicBytes> {
  let current = new URL(input);
  for (let redirect = 0; redirect <= REDIRECT_LIMIT; redirect += 1) {
    const address = await publicAddress(current);
    const dispatcher = new Agent({ connect: { lookup: pinnedLookup(address) } });
    try {
      const response = await fetch(current, {
        dispatcher,
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
        headers: {
          "user-agent": "uShelf/0.1 (+local read-later library)",
          accept: options.accept,
        },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new Error("Redirect response did not include a location");
        await response.body?.cancel();
        current = new URL(location, current);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Source returned HTTP ${response.status}`);
      }
      const type = (response.headers.get("content-type") ?? "")
        .split(";", 1)[0]!
        .trim()
        .toLowerCase();
      const declaredLength = Number(response.headers.get("content-length") ?? 0);
      if (declaredLength > options.maxBytes) {
        await response.body?.cancel();
        throw new Error("Resource exceeds the size limit");
      }
      const bytes = await readBoundedBody(response, options.maxBytes);
      return { bytes, contentType: type, finalUrl: current.toString() };
    } finally {
      await dispatcher.close();
    }
  }
  throw new Error("Source redirected too many times");
}

async function readBoundedBody(response: UndiciResponse, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error("Resource exceeds the size limit");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function publicAddress(url: URL): Promise<string> {
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("Only HTTP and HTTPS are supported");
  if (url.username || url.password) throw new Error("Source URLs may not contain credentials");
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error("Local network sources are not allowed");
  }
  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("Private network sources are not allowed");
  }
  return addresses[0]!.address;
}

export function pinnedLookup(address: string): LookupFunction {
  const family = isIP(address);
  if (family !== 4 && family !== 6) throw new Error("Resolved source address is invalid");
  return ((
    _hostname: string,
    options: { all?: boolean },
    callback: (...args: unknown[]) => void,
  ) => {
    if (options.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  }) as LookupFunction;
}

export function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  const family = isIP(normalized);
  if (family === 4) return privateNetworkBlocks.check(normalized, "ipv4");
  if (family === 6) {
    if (privateNetworkBlocks.check(normalized, "ipv6")) return true;
    const embedded = translatedIPv4(normalized);
    return embedded !== undefined && privateNetworkBlocks.check(embedded, "ipv4");
  }
  return false;
}

/**
 * Returns the IPv4 address that NAT64 (64:ff9b::/96) or 6to4 (2002::/16) traffic is delivered to.
 * These prefixes reach public IPv4 sites on IPv6-only hosts, so they are checked, not blocked.
 */
function translatedIPv4(address: string): string | undefined {
  const groups = ipv6Groups(address);
  if (!groups) return undefined;
  const nat64Prefix = [0x64, 0xff9b, 0, 0, 0, 0];
  if (nat64Prefix.every((value, index) => groups[index] === value)) {
    return ipv4FromGroups(groups[6]!, groups[7]!);
  }
  if (groups[0] === 0x2002) return ipv4FromGroups(groups[1]!, groups[2]!);
  return undefined;
}

function ipv6Groups(address: string): number[] | undefined {
  let text = address;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)?.[1];
  if (dotted) {
    const [a, b, c, d] = dotted.split(".").map(Number) as [number, number, number, number];
    text = `${text.slice(0, -dotted.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const missing = 8 - left.length - right.length;
  if (tail === undefined ? missing !== 0 : missing < 1) return undefined;
  const groups = [...left, ...Array<string>(tail === undefined ? 0 : missing).fill("0"), ...right];
  return groups.map((group) => Number.parseInt(group, 16));
}

function ipv4FromGroups(high: number, low: number): string {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}
