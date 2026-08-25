import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchPublicHtml } from "./safe-html-fetcher.js";
import { extractUrl } from "./source-extractor.js";

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
});
