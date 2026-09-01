import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const MAX_BYTES = 5 * 1024 * 1024;
const REDIRECT_LIMIT = 5;

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
    await assertPublicHost(current);
    const response = await fetch(current, {
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
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) throw new Error(`Source returned HTTP ${response.status}`);
    const type = (response.headers.get("content-type") ?? "")
      .split(";", 1)[0]!
      .trim()
      .toLowerCase();
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > options.maxBytes) throw new Error("Resource exceeds the size limit");
    const bytes = await readBoundedBody(response, options.maxBytes);
    return { bytes, contentType: type, finalUrl: current.toString() };
  }
  throw new Error("Source redirected too many times");
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
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
