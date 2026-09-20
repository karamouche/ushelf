import { unzipSync } from "fflate";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import type { ShelfItem } from "../domain/library-item.js";
import { exportKindleEpub } from "./epub-exporter.js";

const itemId = "e7cf9d0d-bba8-4b93-9503-ab8f15de9d2f";
const revision = "a".repeat(64);

function article(): ShelfItem {
  return {
    id: itemId,
    originalUrl: "https://example.com/read",
    canonicalUrl: "https://example.com/read",
    sourceType: "article",
    title: "A <useful> article",
    author: "Ada & Bob",
    capturedAt: "2026-08-19T12:00:00.000Z",
    updatedAt: "2026-08-20T13:14:15.000Z",
    reading: { status: "inbox", progress: 0 },
    tags: [],
    extraction: { status: "complete", method: "readability" },
    enrichment: { status: "complete", recipe: "default", summary: "SECRET INSIGHT" },
    media: {
      source: { discovered: 1, localized: 1, omitted: 0, filtered: 0 },
      insights: { discovered: 0, localized: 0, omitted: 0, filtered: 0 },
    },
    sourceMarkdown: `# Source heading\n\nA table:\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n<script>alert("no")</script>\n\n![Pixel](../../files/${itemId}/media/${"b".repeat(64)}.png)`,
    insightMarkdown: "SECRET INSIGHT BODY",
    revision,
    filePath: "/tmp/item.md",
  };
}

describe("exportKindleEpub", () => {
  it("creates deterministic source-only EPUB content with packaged media", async () => {
    const input = article();
    const png = await sharp({
      create: { width: 1, height: 1, channels: 4, background: "#ffffff" },
    })
      .png()
      .toBuffer();
    const media = [{ filename: `${"b".repeat(64)}.png`, mediaType: "image/png", bytes: png }];
    const first = await exportKindleEpub(input, media);
    const second = await exportKindleEpub(input, media);
    expect(first).toEqual(second);

    expect(Buffer.from(first.subarray(0, 4)).toString("binary")).toBe("PK\u0003\u0004");
    expect(new DataView(first.buffer, first.byteOffset).getUint16(8, true)).toBe(0);
    const firstNameLength = new DataView(first.buffer, first.byteOffset).getUint16(26, true);
    expect(Buffer.from(first.subarray(30, 30 + firstNameLength)).toString()).toBe("mimetype");

    const archive = unzipSync(first);
    expect(Buffer.from(archive.mimetype!).toString()).toBe("application/epub+zip");
    expect(Object.keys(archive)).toEqual(
      expect.arrayContaining([
        "META-INF/container.xml",
        "EPUB/package.opf",
        "EPUB/nav.xhtml",
        "EPUB/article.xhtml",
        "EPUB/styles.css",
      ]),
    );
    expect(Object.keys(archive).some((name) => name.startsWith("EPUB/media/"))).toBe(true);
    const xhtml = Buffer.from(archive["EPUB/article.xhtml"]!).toString();
    expect(xhtml).toContain("Source heading");
    expect(xhtml).toContain("<table>");
    expect(xhtml).toContain("media/");
    expect(xhtml).not.toContain("SECRET INSIGHT");
    expect(xhtml).not.toContain("<script");
    expect(xhtml).toContain("A &lt;useful&gt; article");
  });
});
