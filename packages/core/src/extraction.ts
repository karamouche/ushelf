import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import sanitizeHtml from "sanitize-html";
import TurndownService from "turndown";
import { canonicalizeUrl, detectSourceType } from "./url.js";
import type { ExtractedSource } from "./types.js";

const MAX_BYTES = 5 * 1024 * 1024;
const REDIRECT_LIMIT = 5;

export async function extractUrl(input: string): Promise<ExtractedSource> {
  const canonicalUrl = canonicalizeUrl(input);
  const sourceType = detectSourceType(canonicalUrl);
  const { html, finalUrl } = await safeFetchHtml(canonicalUrl);
  const dom = new JSDOM(html, { url: finalUrl });

  if (sourceType === "x_thread") {
    const extracted = extractPublicX(dom, canonicalUrl);
    if (!extracted)
      throw new AwaitingSourceError(
        "X did not expose enough public thread content; submit it through the agent fallback",
      );
    return extracted;
  }

  return extractReadableArticle(dom, canonicalUrl);
}

export function extractReadableArticle(dom: JSDOM, canonicalUrl: string): ExtractedSource {
  const document = dom.window.document;
  const metadataImage = metadataImageUrl(document, canonicalUrl);
  const classesToPreserve = prepareDocumentForExtraction(document, canonicalUrl);
  const reader = new Readability(document.cloneNode(true) as Document, { classesToPreserve });
  const article = reader.parse();
  if (!article?.content || (article.textContent ?? "").trim().length < 120) {
    throw new Error("The page did not contain a readable article");
  }
  const title = clean(article.title ?? "") || new URL(canonicalUrl).hostname;
  let markdown = htmlToMarkdown(article.content);
  if (metadataImage && !containsMarkdownImage(markdown)) {
    markdown = `![${escapeImageAlt(title)}](${metadataImage})\n\n${markdown}`;
  }
  return {
    sourceType: "blog",
    title,
    ...(article.byline ? { author: clean(article.byline) } : {}),
    markdown,
    method: "readability",
  };
}

export class AwaitingSourceError extends Error {}

async function safeFetchHtml(input: string): Promise<{ html: string; finalUrl: string }> {
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

function extractPublicX(dom: JSDOM, url: string): ExtractedSource | undefined {
  const document = dom.window.document;
  const title = document
    .querySelector('meta[property="og:title"]')
    ?.getAttribute("content")
    ?.trim();
  const description = document
    .querySelector('meta[property="og:description"]')
    ?.getAttribute("content")
    ?.trim();
  if (!description || description.length < 40) return undefined;
  return {
    sourceType: "x_thread",
    title: title || "X thread",
    markdown: `${description}\n\n[View post on X](${url})`,
    method: "public_extract",
  };
}

function htmlToMarkdown(value: string): string {
  const safe = sanitizeHtml(value, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img", "figure", "figcaption"]),
    allowedAttributes: {
      a: ["href", "title"],
      code: ["class"],
      img: ["src", "alt", "title"],
      td: ["align"],
      th: ["align"],
    },
    allowedSchemes: ["http", "https", "mailto"],
  });
  const turndown = new TurndownService({
    headingStyle: "atx",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
  });
  turndown.remove(["script", "style", "noscript", "iframe"]);
  addTableRules(turndown);
  return turndown.turndown(safe).trim();
}

function addTableRules(turndown: TurndownService): void {
  turndown.addRule("tableCell", {
    filter: ["th", "td"],
    replacement(content, node) {
      const value = content
        .replace(/\s*\n\s*/g, " ")
        .trim()
        .replaceAll("|", "\\|");
      return `${node.parentElement?.firstElementChild === node ? "| " : " "}${value} |`;
    },
  });
  turndown.addRule("tableRow", {
    filter: "tr",
    replacement(content, node) {
      const row = node as HTMLTableRowElement;
      const cells = [...row.cells];
      const isFirstRow = row.closest("table")?.querySelector("tr") === row;
      if (!isFirstRow) return `${content}\n`;
      const separator = cells
        .map((cell) => {
          const alignment = cell.getAttribute("align")?.toLowerCase();
          if (alignment === "left") return ":---";
          if (alignment === "right") return "---:";
          if (alignment === "center") return ":---:";
          return "---";
        })
        .join(" | ");
      return `${content}\n| ${separator} |\n`;
    },
  });
  turndown.addRule("table", {
    filter: "table",
    replacement(content) {
      return `\n\n${content.trim()}\n\n`;
    },
  });
  turndown.addRule("tableSection", {
    filter: ["thead", "tbody", "tfoot"],
    replacement(content) {
      return content;
    },
  });
}

function prepareDocumentForExtraction(document: Document, baseUrl: string): string[] {
  const classesToPreserve = new Set<string>();
  for (const anchor of document.querySelectorAll("a[href]")) {
    const href = anchor.getAttribute("href");
    if (href) anchor.setAttribute("href", resolveUrl(href, baseUrl));
  }
  for (const image of document.querySelectorAll("img")) {
    const pictureSource = image.closest("picture")?.querySelector("source");
    const source = [
      image.getAttribute("data-src"),
      image.getAttribute("data-original"),
      firstSrcsetUrl(image.getAttribute("data-srcset")),
      image.getAttribute("src"),
      firstSrcsetUrl(image.getAttribute("srcset")),
      firstSrcsetUrl(pictureSource?.getAttribute("srcset") ?? null),
    ].find(
      (candidate) => candidate && !candidate.startsWith("data:") && !candidate.startsWith("blob:"),
    );
    if (source) image.setAttribute("src", resolveUrl(source, baseUrl));
  }

  // Mermaid is commonly embedded as either a div/pre with a `mermaid` class or a
  // code element carrying a language marker. Normalize those variants before
  // Readability can flatten their structure or discard their identifying class.
  const mermaidElements = [...document.querySelectorAll("div, pre, code")].filter(
    (element) =>
      languageForElement(element) === "mermaid" && !hasMermaidAncestor(element.parentElement),
  );
  for (const element of mermaidElements) {
    const target = element.tagName === "CODE" ? (element.closest("pre") ?? element) : element;
    const replacement = document.createElement("pre");
    const code = document.createElement("code");
    code.className = "language-mermaid";
    code.textContent = element.textContent ?? "";
    replacement.append(code);
    target.replaceWith(replacement);
  }

  // Readability can discard the deeply nested, scrollable wrappers used by documentation
  // sites for syntax-highlighted code. Replace each block with its semantic content first.
  for (const pre of document.querySelectorAll("pre")) {
    const tabPanel = pre.closest('[data-component-part="tab-content"]');
    const replacement = document.createElement("pre");
    const code = document.createElement("code");
    const language = languageForElement(pre) ?? languageForElement(pre.querySelector("code"));
    if (language) {
      code.className = `language-${language}`;
      classesToPreserve.add(code.className);
    }
    code.textContent = pre.textContent ?? "";
    replacement.append(code);
    if (tabPanel) {
      pre.remove();
      tabPanel.append(replacement);
    } else {
      pre.replaceWith(replacement);
    }
  }
  return [...classesToPreserve];
}

function languageForElement(element: Element | null): string | undefined {
  if (!element) return undefined;
  const explicit = element.getAttribute("language") ?? element.getAttribute("data-language");
  if (explicit?.trim()) return explicit.trim().toLowerCase();
  for (const token of element.classList) {
    const normalized = token.toLowerCase();
    if (normalized === "mermaid") return "mermaid";
    if (normalized.startsWith("language-") && normalized.length > "language-".length)
      return normalized.slice("language-".length);
  }
  return undefined;
}

function hasMermaidAncestor(element: Element | null): boolean {
  for (let current = element; current; current = current.parentElement) {
    if (languageForElement(current) === "mermaid") return true;
  }
  return false;
}

function firstSrcsetUrl(srcset: string | null): string | undefined {
  return srcset?.split(",")[0]?.trim().split(/\s+/)[0] || undefined;
}

function resolveUrl(value: string, baseUrl: string): string {
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return value;
  }
}

function metadataImageUrl(document: Document, baseUrl: string): string | undefined {
  const value =
    document.querySelector('meta[property="og:image"]')?.getAttribute("content") ||
    document.querySelector('meta[name="twitter:image"]')?.getAttribute("content");
  if (!value) return undefined;
  const resolved = resolveUrl(value, baseUrl);
  try {
    const protocol = new URL(resolved).protocol;
    return protocol === "http:" || protocol === "https:" ? resolved : undefined;
  } catch {
    return undefined;
  }
}

function containsMarkdownImage(markdown: string): boolean {
  return markdown.includes("![");
}

function escapeImageAlt(value: string): string {
  return value.replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
