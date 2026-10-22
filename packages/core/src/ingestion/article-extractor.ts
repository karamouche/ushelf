import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import sanitizeHtml from "sanitize-html";
import TurndownService from "turndown";
import type { ExtractedSource } from "./source-extractor.js";

const CODE_CONTROLS = "button, [role=button], svg";
const NON_CODE_CONTENT =
  "img, figure, video, audio, iframe, table, blockquote, ul, ol, h1, h2, h3, h4, h5, h6, p";

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
  normalizeImages(document, baseUrl);

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

  // Readability can discard deeply nested presentation wrappers around otherwise semantic
  // code. Promote the normalized block through ancestors that contain no other content.
  const crowded = new WeakSet<Element>();
  for (const pre of document.querySelectorAll("pre")) {
    const replacement = document.createElement("pre");
    const code = document.createElement("code");
    const text = extractCodeText(pre);
    const language = languageForElement(pre) ?? languageForElement(pre.querySelector("code"));
    if (language) {
      code.className = `language-${language}`;
      classesToPreserve.add(code.className);
    }
    code.textContent = text;
    replacement.append(code);
    highestCodeOnlyAncestor(pre, text, crowded).replaceWith(replacement);
  }
  return [...classesToPreserve];
}

function normalizeImages(document: Document, baseUrl: string): void {
  const figures = new Map<Element, FigureShape>();
  const crowded = new WeakSet<Element>();
  for (const image of [...document.querySelectorAll("img")]) {
    if (!image.isConnected) continue;
    const pictureSource = image.closest("picture")?.querySelector("source");
    const source = [
      image.getAttribute("data-src"),
      image.getAttribute("data-original"),
      firstSrcsetUrl(image.getAttribute("data-srcset")),
      image.getAttribute("src"),
      firstSrcsetUrl(image.getAttribute("srcset")),
      firstSrcsetUrl(pictureSource?.getAttribute("srcset") ?? null),
    ].find((candidate) => candidate && !candidate.startsWith("blob:"));
    if (!source) continue;
    image.setAttribute("src", resolveUrl(source, baseUrl));

    const figure = image.closest("figure");
    const shape = figure ? figureShape(figure, figures) : undefined;
    const target = highestImageOnlyAncestor(image, figure, shape, crowded);
    if (target === image) continue;
    const normalized = document.createElement("figure");
    const normalizedImage = document.createElement("img");
    for (const attribute of ["src", "alt", "title"] as const) {
      const value = image.getAttribute(attribute);
      if (value !== null) normalizedImage.setAttribute(attribute, value);
    }
    normalized.append(normalizedImage);
    if (shape?.caption) normalized.append(shape.caption.cloneNode(true));
    target.replaceWith(normalized);
  }
}

function highestCodeOnlyAncestor(
  pre: Element,
  codeText: string,
  crowded: WeakSet<Element>,
): Element {
  const text = normalizedWhitespace(codeText);
  // The first wrapper gets the full check, which also covers controls and blocks inside the
  // pre itself. Above it, a wrapper adds nothing exactly when its other children are empty,
  // so only those siblings are checked and the climb stays linear however deep it goes.
  const first = pre.parentElement;
  if (
    !first ||
    first.tagName === "BODY" ||
    !onlyChildWithContent(first, pre, hasCodeSiblingContent, crowded) ||
    codeContentText(first) !== text ||
    first.querySelectorAll("pre").length !== 1 ||
    first.querySelector(NON_CODE_CONTENT)
  ) {
    return pre;
  }
  let target = first;
  while (
    target.parentElement &&
    target.parentElement.tagName !== "BODY" &&
    onlyChildWithContent(target.parentElement, target, hasCodeSiblingContent, crowded)
  ) {
    target = target.parentElement;
  }
  return target;
}

function hasCodeSiblingContent(node: Node): boolean {
  if (node.nodeType === 3) return Boolean(node.textContent?.trim());
  if (node.nodeType !== 1) return false;
  const element = node as Element;
  if (element.matches(`pre, ${NON_CODE_CONTENT}`)) return true;
  if (element.querySelector(`pre, ${NON_CODE_CONTENT}`)) return true;
  if (element.matches(CODE_CONTROLS) || !element.textContent?.trim()) return false;
  const clone = element.cloneNode(true) as Element;
  for (const control of clone.querySelectorAll(CODE_CONTROLS)) control.remove();
  return Boolean(clone.textContent?.trim());
}

/**
 * Whether every child of `parent` other than `child` is empty, so climbing to `parent` adds
 * nothing to the promoted block. A parent with two children holding content can never be
 * climbed, and replacing a promoted block keeps that count, so it is remembered: many blocks
 * sharing one container then cost one scan of that container instead of one each.
 */
function onlyChildWithContent(
  parent: Element,
  child: Element,
  hasContent: (node: Node) => boolean,
  crowded: WeakSet<Element> | undefined,
): boolean {
  if (crowded?.has(parent)) return false;
  let withContent = 0;
  let others = false;
  for (const node of parent.childNodes) {
    if (node !== child && !hasContent(node)) continue;
    withContent += 1;
    if (node !== child) others = true;
    if (withContent > 1) {
      crowded?.add(parent);
      return false;
    }
  }
  return !others;
}

function codeContentText(element: Element): string {
  const clone = element.cloneNode(true) as Element;
  for (const control of clone.querySelectorAll(CODE_CONTROLS)) control.remove();
  const pre = clone.matches("pre") ? clone : clone.querySelector("pre");
  if (pre && clone.querySelectorAll("pre").length === 1) {
    pre.replaceWith(extractCodeText(pre));
  }
  return normalizedText(clone);
}

function extractCodeText(pre: Element): string {
  const root = pre.querySelector("code") ?? pre;
  const nodes = [...root.childNodes];
  const lineElements = nodes.filter(
    (node): node is Element =>
      node.nodeType === 1 && ["DIV", "P", "LI"].includes((node as Element).tagName),
  );
  const usesLineContainers =
    lineElements.length > 0 &&
    nodes.every(
      (node) =>
        lineElements.includes(node as Element) ||
        node.nodeType === 8 ||
        (node.nodeType === 3 && !(node.textContent ?? "").trim()),
    );
  if (usesLineContainers) return lineElements.map(textWithBreaks).join("\n");
  return textWithBreaks(root);
}

function textWithBreaks(element: Element): string {
  const clone = element.cloneNode(true) as Element;
  for (const br of clone.querySelectorAll("br")) br.replaceWith("\n");
  return clone.textContent ?? "";
}

interface FigureShape {
  caption: Element | null;
  imageOnly: boolean;
}

// Every image of a figure needs the same caption and image count, so read them once.
function figureShape(figure: Element, figures: Map<Element, FigureShape>): FigureShape {
  let shape = figures.get(figure);
  if (!shape) {
    const caption = figure.querySelector("figcaption");
    shape = {
      caption,
      imageOnly:
        figure.querySelectorAll("img").length === 1 &&
        normalizedText(figure) === normalizedText(caption),
    };
    figures.set(figure, shape);
  }
  return shape;
}

function highestImageOnlyAncestor(
  image: Element,
  figure: Element | null,
  shape: FigureShape | undefined,
  crowded: WeakSet<Element>,
): Element {
  const caption = shape?.caption ?? null;
  const text = normalizedText(caption);
  // A child holding the caption is left to the full check below.
  const hasContent = (node: Node): boolean =>
    !(caption && node.contains(caption)) &&
    (node.nodeType === 3
      ? Boolean(node.textContent?.trim())
      : node.nodeType === 1 &&
        ((node as Element).matches("img") ||
          Boolean((node as Element).querySelector("img")) ||
          Boolean(node.textContent?.trim())));
  // Whether a parent can be climbed depends on the caption, so only share it without one.
  const crowdedParents = caption ? undefined : crowded;
  let target = figure && shape?.imageOnly ? figure : image;
  // Without a caption the target holds one image and no text, and so does a parent whose other
  // children are empty. A caption can sit beside the image, so it needs the full check.
  while (
    target.parentElement &&
    target.parentElement.tagName !== "BODY" &&
    onlyChildWithContent(target.parentElement, target, hasContent, crowdedParents) &&
    (!caption ||
      (target.parentElement.querySelectorAll("img").length === 1 &&
        normalizedText(target.parentElement) === text))
  ) {
    target = target.parentElement;
  }
  return target;
}

function normalizedText(element: Element | null): string {
  return normalizedWhitespace(element?.textContent ?? "");
}

function normalizedWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
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
