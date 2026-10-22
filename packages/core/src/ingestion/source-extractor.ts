import { Worker } from "node:worker_threads";
import type { SourceType } from "../domain/library-item.js";
import type { HtmlExtractionRequest, HtmlExtractionResult } from "./html-extraction-worker.js";
import { fetchPublicHtml } from "./safe-html-fetcher.js";
import { canonicalizeUrl, detectSourceType } from "./source-url.js";

const HTML_EXTRACTION_TIMEOUT_MS = 60_000;
const HTML_WORKER_HEAP_MB = 512;
// Readability recurses through the tree and slows sharply with depth. A stack the size of the
// main thread's makes absurdly nested pages fail fast instead of running to the time limit.
const HTML_WORKER_STACK_MB = 1;
const HTML_WORKER_ERROR = "Page extraction failed unexpectedly";
// A worker thread runs JavaScript, so tests running Core from source also start the compiled
// worker; `pnpm test` builds Core first. From src/ and dist/ alike this resolves to dist/.
const HTML_WORKER_URL = new URL("../../dist/ingestion/html-extraction-worker.js", import.meta.url);

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
  return extractHtml({ html, finalUrl, canonicalUrl, sourceType });
}

// Parsing alone grows with the square of a page's nesting depth, and extraction mutates large
// DOMs, so a hostile page could otherwise stall every request for minutes. The worker keeps
// the event loop free and is terminated past the time or memory budget.
function extractHtml(request: HtmlExtractionRequest): Promise<ExtractedSource> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(HTML_WORKER_URL, {
      workerData: request,
      resourceLimits: {
        maxOldGenerationSizeMb: HTML_WORKER_HEAP_MB,
        stackSizeMb: HTML_WORKER_STACK_MB,
      },
    });
    let settled = false;
    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      void worker.terminate();
      finish();
    };
    const deadline = setTimeout(
      () => settle(() => reject(new Error("The page took too long to extract"))),
      HTML_EXTRACTION_TIMEOUT_MS,
    );
    worker.once("message", (result: HtmlExtractionResult) =>
      settle(() => {
        if ("source" in result) resolve(result.source);
        else if ("awaitingSource" in result)
          reject(
            new AwaitingSourceError(
              "X did not expose enough public content; submit it through the agent fallback",
            ),
          );
        else reject(new Error(result.error));
      }),
    );
    worker.once("error", (error: Error & { code?: string }) =>
      settle(() =>
        reject(
          new Error(
            error.code === "ERR_WORKER_OUT_OF_MEMORY"
              ? "The page needs too much memory to extract"
              : HTML_WORKER_ERROR,
          ),
        ),
      ),
    );
    worker.once("exit", () => settle(() => reject(new Error(HTML_WORKER_ERROR))));
  });
}

export class AwaitingSourceError extends Error {}
