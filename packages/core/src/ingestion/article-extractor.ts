import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import sanitizeHtml from "sanitize-html";
import TurndownService from "turndown";
import type { ExtractedSource } from "./source-extractor.js";

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
    sourceType: "article",
    title,
    ...(article.byline ? { author: clean(article.byline) } : {}),
    markdown,
    method: "readability",
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
    allowedSchemesByTag: { img: ["http", "https", "data"] },
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
    ].find((candidate) => candidate && !candidate.startsWith("blob:"));
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
