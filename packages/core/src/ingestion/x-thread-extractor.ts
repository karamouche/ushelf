import type { JSDOM } from "jsdom";
import type { ExtractedSource } from "./source-extractor.js";

export function extractPublicX(dom: JSDOM, url: string): ExtractedSource | undefined {
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
