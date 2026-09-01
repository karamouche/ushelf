import type { JSDOM } from "jsdom";
import type { ExtractedSource } from "./source-extractor.js";

export function extractPublicX(dom: JSDOM, url: string): ExtractedSource | undefined {
  const document = dom.window.document;
  const metadataTitle = document
    .querySelector('meta[property="og:title"]')
    ?.getAttribute("content")
    ?.trim();
  const description = document
    .querySelector('meta[property="og:description"]')
    ?.getAttribute("content")
    ?.trim();
  if (!description) return undefined;
  const title = metadataTitle || "X";
  const image = metadataImageUrl(document);
  return {
    sourceType: "x",
    title,
    markdown: `${image ? `![${escapeImageAlt(title)}](${image})\n\n` : ""}${description}\n\n[View post on X](${url})`,
    method: "public_extract",
  };
}

function metadataImageUrl(document: Document): string | undefined {
  const candidates = [
    document.querySelector('meta[property="og:image"]')?.getAttribute("content"),
    document.querySelector('meta[name="twitter:image"]')?.getAttribute("content"),
  ];
  for (const value of candidates) {
    if (!value) continue;
    try {
      const url = new URL(value);
      if (url.protocol === "http:" || url.protocol === "https:") return url.toString();
    } catch {
      // Try the next public metadata image.
    }
  }
  return undefined;
}

function escapeImageAlt(value: string): string {
  return value.replaceAll("[", "\\[").replaceAll("]", "\\]");
}
