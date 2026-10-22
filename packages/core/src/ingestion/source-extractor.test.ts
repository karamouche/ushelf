import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchPublicHtml } from "./safe-html-fetcher.js";
import { AwaitingSourceError, extractUrl } from "./source-extractor.js";

vi.mock("./safe-html-fetcher.js", () => ({ fetchPublicHtml: vi.fn() }));

const mockedFetchPublicHtml = vi.mocked(fetchPublicHtml);

beforeEach(() => mockedFetchPublicHtml.mockReset());

describe("source extraction", () => {
  it("uses the final response URL to resolve redirected article assets", async () => {
    mockedFetchPublicHtml.mockResolvedValue({
      finalUrl: "https://cdn.example.test/articles/final/",
      html: `<html><head><title>Redirected guide</title></head><body><main><article>
        <h1>Redirected guide</h1>
        <p>A useful introduction with enough text for Readability to identify this as an article.</p>
        <p><a href="next">Continue reading</a></p>
        <img src="images/diagram.png" alt="Redirected diagram">
        <p>This closing explanation contains enough additional prose to keep extraction deterministic.</p>
      </article></main></body></html>`,
    });

    const result = await extractUrl("https://example.test/short-link");

    expect(result.markdown).toContain(
      "[Continue reading](https://cdn.example.test/articles/final/next)",
    );
    expect(result.markdown).toContain(
      "![Redirected diagram](https://cdn.example.test/articles/final/images/diagram.png)",
    );
  });

  it("keeps the event loop responsive while a hostile page is parsed", async () => {
    // Parsing grows with the square of nesting depth; this page took seconds on the main thread.
    const nested = "<div>".repeat(3000) + "<p>deep</p>" + "</div>".repeat(3000);
    mockedFetchPublicHtml.mockResolvedValue({
      finalUrl: "https://example.test/nested",
      html: `<html><body><article>${nested.repeat(3)}</article></body></html>`,
    });
    let longestGap = 0;
    let last = performance.now();
    const ticker = setInterval(() => {
      const now = performance.now();
      longestGap = Math.max(longestGap, now - last);
      last = now;
    }, 10);

    // The page is too deep to extract; only how long the event loop stalls matters here.
    await extractUrl("https://example.test/nested").catch(() => undefined);
    clearInterval(ticker);
    // A blocked event loop resumes here before the ticker can run again, so count that gap too.
    longestGap = Math.max(longestGap, performance.now() - last);

    expect(longestGap).toBeLessThan(500);
  });

  it("reports X pages without public content as awaiting the agent fallback", async () => {
    mockedFetchPublicHtml.mockResolvedValue({
      finalUrl: "https://x.com/example/status/1",
      html: "<html><body><div id=react-root></div></body></html>",
    });

    await expect(extractUrl("https://x.com/example/status/1")).rejects.toBeInstanceOf(
      AwaitingSourceError,
    );
  });

  it("reports extraction failures from the worker", async () => {
    mockedFetchPublicHtml.mockResolvedValue({
      finalUrl: "https://example.test/empty",
      html: "<html><body><p>Too short.</p></body></html>",
    });

    await expect(extractUrl("https://example.test/empty")).rejects.toThrow(
      "The page did not contain a readable article",
    );
  });
});
