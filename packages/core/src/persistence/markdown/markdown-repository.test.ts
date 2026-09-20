import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

    expect(imported.filePath).toBe(
      path.join(config.itemsDir, "2026", `imported-article--${frontmatter.id}.md`),
    );
    expect(await readFile(imported.filePath, "utf8")).toBe(raw);
    expect(
      (await readdir(path.dirname(imported.filePath))).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  });

  it("keeps same-named imports distinct and never overwrites an existing item", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ushelf-repository-test-"));
    roots.push(root);
    const config = resolveConfig(root);
    const repository = new MarkdownRepository(config);
    await repository.initialize();

    const firstDirectory = path.join(root, "first");
    const secondDirectory = path.join(root, "second");
    await Promise.all([
      mkdir(firstDirectory, { recursive: true }),
      mkdir(secondDirectory, { recursive: true }),
    ]);
    const first = articleFrontmatter();
    const second = {
      ...articleFrontmatter(),
      id: "08cdfb2c-80a3-4862-92c5-61011e4bf20e",
      originalUrl: "https://example.com/second",
      canonicalUrl: "https://example.com/second",
      title: "Second article",
    };
    const firstRaw = renderItemMarkdown(first, "", "First source text.");
    const secondRaw = renderItemMarkdown(second, "", "Second source text.");
    const firstPath = path.join(firstDirectory, "incoming.md");
    const secondPath = path.join(secondDirectory, "incoming.md");
    await Promise.all([
      writeFile(firstPath, firstRaw, "utf8"),
      writeFile(secondPath, secondRaw, "utf8"),
    ]);

    const firstImported = await repository.importFile(firstPath);
    const secondImported = await repository.importFile(secondPath);

    expect(firstImported.filePath).not.toBe(secondImported.filePath);
    expect(await readFile(firstImported.filePath, "utf8")).toBe(firstRaw);
    expect(await readFile(secondImported.filePath, "utf8")).toBe(secondRaw);
    await expect(repository.importFile(firstPath)).rejects.toThrow(/already exists/);
    expect(await readFile(firstImported.filePath, "utf8")).toBe(firstRaw);
  });
});

function articleFrontmatter(): ItemFrontmatter {
  return {
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
    media: {
      source: { discovered: 0, localized: 0, omitted: 0, filtered: 0 },
      insights: { discovered: 0, localized: 0, omitted: 0, filtered: 0 },
    },
  };
}
