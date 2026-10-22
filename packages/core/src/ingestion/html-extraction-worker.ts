// Worker thread entry started by source-extractor.ts. Parsing and extracting an untrusted page
// can take long enough to block an event loop, so it runs here where the server can stop it.
import { parentPort, workerData } from "node:worker_threads";
import { JSDOM } from "jsdom";
import type { SourceType } from "../domain/library-item.js";
import { extractReadableArticle } from "./article-extractor.js";
import type { ExtractedSource } from "./source-extractor.js";
import { extractPublicX } from "./x-extractor.js";

export interface HtmlExtractionRequest {
  html: string;
  finalUrl: string;
  canonicalUrl: string;
  sourceType: SourceType;
}

export type HtmlExtractionResult =
  { source: ExtractedSource } | { awaitingSource: true } | { error: string };

function extract({
  html,
  finalUrl,
  canonicalUrl,
  sourceType,
}: HtmlExtractionRequest): HtmlExtractionResult {
  try {
    const dom = new JSDOM(html, { url: finalUrl });
    if (sourceType === "x") {
      const extracted = extractPublicX(dom, canonicalUrl);
      return extracted ? { source: extracted } : { awaitingSource: true };
    }
    return { source: extractReadableArticle(dom, finalUrl) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

parentPort?.postMessage(extract(workerData as HtmlExtractionRequest));
