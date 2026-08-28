import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../../configuration/ushelf-config.js";
import type { ItemFrontmatter } from "../../domain/library-item.js";
import { renderItemMarkdown } from "./item-markdown.js";
import { MarkdownRepository } from "./markdown-repository.js";

const roots: string[] = [];

afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

describe("MarkdownRepository imports", () => {
  it("atomically preserves validated Markdown bytes in the canonical library", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ushelf-repository-test-"));
    roots.push(root);
    const config = resolveConfig(root);
    const repository = new MarkdownRepository(config);
    await repository.initialize();

    const frontmatter = articleFrontmatter();
    const raw = renderItemMarkdown(frontmatter, "", "Imported source text.");
    const sourcePath = path.join(root, "incoming.md");
    await writeFile(sourcePath, raw, "utf8");

    const imported = await repository.importFile(sourcePath);

    expect(imported.filePath).toBe(path.join(config.itemsDir, "2026", "incoming.md"));
    expect(await readFile(imported.filePath, "utf8")).toBe(raw);
    expect(
      (await readdir(path.dirname(imported.filePath))).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  });
});

function articleFrontmatter(): ItemFrontmatter {
  return {
    schemaVersion: 1,
    id: "6aa8a9fb-a12b-4590-b626-e31d1b5fc4ef",
    originalUrl: "https://example.com/imported",
    canonicalUrl: "https://example.com/imported",
    sourceType: "article",
    title: "Imported article",
    capturedAt: "2026-08-25T12:00:00.000Z",
    updatedAt: "2026-08-25T12:00:00.000Z",
    reading: { status: "inbox", progress: 0 },
    tags: [],
    extraction: {
      status: "complete",
      method: "readability",
      retrievedAt: "2026-08-25T12:00:00.000Z",
      contentHash: "source-hash",
    },
    enrichment: { status: "pending", recipe: "default" },
  };
}
