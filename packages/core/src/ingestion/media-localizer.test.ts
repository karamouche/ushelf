import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchPublicBytes } from "./safe-html-fetcher.js";
import {
  assertLocalMarkdownImages,
  localizeMarkdownImages,
  validateImage,
} from "./media-localizer.js";

vi.mock("./safe-html-fetcher.js", () => ({ fetchPublicBytes: vi.fn() }));

const mockedFetch = vi.mocked(fetchPublicBytes);
const ITEM_ID = "e7cf9d0d-bba8-4b93-9503-ab8f15de9d2f";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n3sAAAAASUVORK5CYII=",
  "base64",
);

beforeEach(() => mockedFetch.mockReset());

describe("Markdown media localization", () => {
  it("stores content-addressed data images and deduplicates their bytes", async () => {
    const data = `data:image/png;base64,${PNG.toString("base64")}`;
    const result = await localizeMarkdownImages(`![First](${data})\n\n![Second](${data})`, ITEM_ID);

    expect(result.assets).toHaveLength(1);
    expect(result.stats).toEqual({ discovered: 2, localized: 2, omitted: 0, filtered: 0 });
    expect(result.markdown).not.toContain("data:image");
    expect(
      result.markdown.match(new RegExp(`\\.\\./\\.\\./files/${ITEM_ID}/media/`, "g")),
    ).toHaveLength(2);
  });

  it("downloads validated remote images and removes failed remote references", async () => {
    mockedFetch
      .mockResolvedValueOnce({
        bytes: PNG,
        contentType: "image/png",
        finalUrl: "https://cdn.example.test/image.png",
      })
      .mockRejectedValueOnce(new Error("blocked"));

    const result = await localizeMarkdownImages(
      "![Saved](https://cdn.example.test/image.png)\n\n![Missing](https://private.test/a.png)",
      ITEM_ID,
    );

    expect(result.stats).toEqual({ discovered: 2, localized: 1, omitted: 1, filtered: 0 });
    expect(result.markdown).not.toContain("https://");
    expect(result.markdown).toContain("*Image omitted: Missing.*");
  });

  it("preserves encoded image transformation queries while localizing", async () => {
    const url =
      "https://kimi-file.example.test/image?x-tos-process=image%2Fauto-orient%2C1%2Fstrip%2Fignore-error%2C1";
    mockedFetch.mockResolvedValue({
      bytes: PNG,
      contentType: "image/png",
      finalUrl: url,
    });

    const result = await localizeMarkdownImages(`![Workflow](${url})`, ITEM_ID);

    expect(mockedFetch).toHaveBeenCalledWith(url, {
      accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,image/svg+xml",
      maxBytes: 10 * 1024 * 1024,
    });
    expect(result.stats).toEqual({ discovered: 1, localized: 1, omitted: 0, filtered: 0 });
    expect(result.markdown).toContain(`![Workflow](../../files/${ITEM_ID}/media/`);
    expect(result.markdown).not.toContain("x-tos-process");
  });

  it("rejects non-local image references during import", () => {
    expect(() =>
      assertLocalMarkdownImages("![Remote](https://example.com/a.png)", ITEM_ID),
    ).toThrow(/non-local image/);
  });

  it("omits canonical-looking references when their local file is missing", async () => {
    const filename = `${"a".repeat(64)}.png`;
    const result = await localizeMarkdownImages(
      `![Missing](../../files/${ITEM_ID}/media/${filename})`,
      ITEM_ID,
    );
    expect(result.stats).toMatchObject({ localized: 0, omitted: 1 });
    expect(result.markdown).toBe("*Image omitted: Missing.*");
  });

  it("localizes reference-style Markdown images", async () => {
    mockedFetch.mockResolvedValue({
      bytes: PNG,
      contentType: "image/png",
      finalUrl: "https://cdn.example.test/figure.png",
    });
    const result = await localizeMarkdownImages(
      "![A figure][figure]\n\n[figure]: https://cdn.example.test/figure.png",
      ITEM_ID,
    );

    expect(result.stats.localized).toBe(1);
    expect(result.markdown).toContain(`![A figure](../../files/${ITEM_ID}/media/`);
  });

  it("sanitizes active and externally loaded SVG content", () => {
    const result = validateImage(
      new TextEncoder().encode(
        '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script><image href="https://tracker.test/pixel.png"/><rect style="fill:url(https://tracker.test/a)"/></svg>',
      ),
      "image/svg+xml",
    );
    const svg = new TextDecoder().decode(result.bytes);
    expect(svg).not.toContain("script");
    expect(svg).not.toContain("onload");
    expect(svg).not.toContain("tracker.test");
  });
});
