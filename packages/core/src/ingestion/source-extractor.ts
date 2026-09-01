import { JSDOM } from "jsdom";
import type { SourceType } from "../domain/library-item.js";
import { extractReadableArticle } from "./article-extractor.js";
import { fetchPublicHtml } from "./safe-html-fetcher.js";
import { canonicalizeUrl, detectSourceType } from "./source-url.js";
import { extractPublicX } from "./x-extractor.js";

export interface ExtractedSource {
  sourceType: SourceType;
  title: string;
  author?: string;
  publishedAt?: string;
  markdown: string;
  method: "readability" | "public_extract";
}

export async function extractUrl(input: string): Promise<ExtractedSource> {
  const canonicalUrl = canonicalizeUrl(input);
  const sourceType = detectSourceType(canonicalUrl);
  const { html, finalUrl } = await fetchPublicHtml(canonicalUrl);
  const dom = new JSDOM(html, { url: finalUrl });

  if (sourceType === "x") {
    const extracted = extractPublicX(dom, canonicalUrl);
    if (!extracted)
      throw new AwaitingSourceError(
        "X did not expose enough public content; submit it through the agent fallback",
      );
    return extracted;
  }

  return extractReadableArticle(dom, finalUrl);
}

export class AwaitingSourceError extends Error {}
