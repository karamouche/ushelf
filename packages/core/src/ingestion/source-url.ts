const TRACKING_PARAMS = new Set(["fbclid", "gclid", "mc_cid", "mc_eid", "ref_src", "ref_url"]);

export function canonicalizeUrl(input: string): string {
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only HTTP and HTTPS URLs are supported");
  }
  if (url.username || url.password) throw new Error("URLs containing credentials are not allowed");

  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("utm_") || TRACKING_PARAMS.has(key.toLowerCase())) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

export function detectSourceType(input: string): "article" | "x" {
  const host = new URL(input).hostname.toLowerCase().replace(/^www\./, "");
  return host === "x.com" || host === "twitter.com" ? "x" : "article";
}
