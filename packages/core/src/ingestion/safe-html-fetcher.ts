import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const MAX_BYTES = 5 * 1024 * 1024;
const REDIRECT_LIMIT = 5;

export async function fetchPublicHtml(input: string): Promise<{ html: string; finalUrl: string }> {
  let current = new URL(input);
  for (let redirect = 0; redirect <= REDIRECT_LIMIT; redirect += 1) {
    await assertPublicHost(current);
    const response = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
      headers: {
        "user-agent": "uShelf/0.1 (+local read-later library)",
        accept: "text/html,application/xhtml+xml",
      },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Redirect response did not include a location");
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) throw new Error(`Source returned HTTP ${response.status}`);
    const type = response.headers.get("content-type") ?? "";
    if (!type.includes("text/html") && !type.includes("application/xhtml+xml")) {
      throw new Error(`Unsupported source content type: ${type || "unknown"}`);
    }
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > MAX_BYTES) throw new Error("Source is larger than 5 MB");
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_BYTES) throw new Error("Source is larger than 5 MB");
    return { html: new TextDecoder().decode(buffer), finalUrl: current.toString() };
  }
  throw new Error("Source redirected too many times");
}

async function assertPublicHost(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("Only HTTP and HTTPS are supported");
  if (url.username || url.password) throw new Error("Source URLs may not contain credentials");
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error("Local network sources are not allowed");
  }
  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("Private network sources are not allowed");
  }
}

export function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (
    normalized === "::1" ||
    normalized === "::" ||
    normalized.startsWith("fe80:") ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd")
  )
    return true;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  const ipv4 = mapped ?? (isIP(normalized) === 4 ? normalized : undefined);
  if (!ipv4) return false;
  const [a = 0, b = 0] = ipv4.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}
