import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../configuration/ushelf-config.js";
import type { ItemFrontmatter } from "../domain/library-item.js";
import { sha256 } from "../persistence/markdown/item-markdown.js";
import { MarkdownRepository } from "../persistence/markdown/markdown-repository.js";
import { ShelfDatabase } from "../persistence/sqlite/shelf-database.js";
import { ShelfService } from "./shelf-service.js";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ushelf-test-"));
  roots.push(root);
  const config = resolveConfig(root);
  const repository = new MarkdownRepository(config);
  const database = new ShelfDatabase(config.databasePath, config.itemsDir);
  const service = new ShelfService(config);
  await repository.initialize();
  await import("node:fs/promises").then(({ writeFile }) =>
    writeFile(
      path.join(config.recipesDir, "default.md"),
      "---\nname: default\ndescription: Test recipe\n---\n\nExplain the source.",
    ),
  );
  const now = "2026-08-19T12:00:00.000Z";
  const frontmatter: ItemFrontmatter = {
    schemaVersion: 1,
    id: "e7cf9d0d-bba8-4b93-9503-ab8f15de9d2f",
    originalUrl: "https://x.com/a/status/1",
    canonicalUrl: "https://x.com/a/status/1",
    sourceType: "x_thread",
    title: "Pending thread",
    capturedAt: now,
    updatedAt: now,
    reading: { status: "inbox", progress: 0 },
    tags: [],
    extraction: { status: "pending" },
    enrichment: { status: "pending", recipe: "default" },
  };
  const item = await repository.save(frontmatter, "", "");
  database.upsert(item);
  return { root, config, service, database, item };
}

describe("agent-driven workflow", () => {
  it("resumes source fallback, saves insights, persists reading state, and rebuilds from Markdown", async () => {
    const { config, service, database, item } = await fixture();
    const sourceUrl = "https://x.com/a/status/1";
    const sourced = await service.submitSourceContent({
      itemId: item.id,
      title: "A useful thread",
      markdown: `First post with enough detail to be useful.\n\n[Original](${sourceUrl})`,
      author: "A",
      revision: item.revision,
    });
    const context = await service.ingestionContext(item.id);
    const ready = await service.saveInsights({
      itemId: item.id,
      recipeHash: context.recipe.hash,
      revision: sourced.revision,
      summary: "A compact test summary.",
      keyPoints: ["One grounded point"],
      tags: ["Testing"],
      citations: [{ url: sourceUrl, label: "Original post" }],
      bodyMarkdown: "### Why it matters\n\nIt proves the workflow.",
    });
    expect(ready.enrichment.status).toBe("complete");
    expect(ready.tags).toEqual(["testing"]);
    expect(ready.insightMarkdown).toBe("### Why it matters\n\nIt proves the workflow.");
    const read = await service.updateReading(item.id, "read", 0.4, ready.revision);
    expect(read.reading.progress).toBe(1);
    database.clearIndex();
    expect(service.listItems()).toHaveLength(0);
    expect(await service.rebuildIndex()).toBe(1);
    expect(service.listItems()[0]).toMatchObject({
      title: "A useful thread",
      status: "read",
      ingestionState: "ready",
    });
    expect(await readFile(read.filePath, "utf8")).toContain("## Source");
    expect(read.filePath.startsWith(config.itemsDir)).toBe(true);
  });

  it("rejects stale writes and unsafe citations", async () => {
    const { service, item } = await fixture();
    const sourced = await service.submitSourceContent({
      itemId: item.id,
      title: "Thread",
      markdown: "A complete source that contains enough characters for fallback acceptance.",
      revision: item.revision,
    });
    const context = await service.ingestionContext(item.id);
    await expect(
      service.saveInsights({
        itemId: item.id,
        recipeHash: context.recipe.hash,
        revision: sha256("stale"),
        summary: "Summary",
        keyPoints: ["Point"],
        tags: [],
        citations: [],
        bodyMarkdown: "",
      }),
    ).rejects.toThrow(/changed/);
    await expect(
      service.saveInsights({
        itemId: item.id,
        recipeHash: context.recipe.hash,
        revision: sourced.revision,
        summary: "Summary",
        keyPoints: ["Point"],
        tags: [],
        citations: [{ url: "https://example.com/not-in-source", label: "Made up" }],
        bodyMarkdown: "",
      }),
    ).rejects.toThrow(/not present/);
  });

  it("shares portable index paths across different roots", async () => {
    const { root, config, service, database, item } = await fixture();
    const aliasRoot = `${root}-alias`;
    roots.push(aliasRoot);
    await symlink(root, aliasRoot, "dir");

    const aliasService = new ShelfService(resolveConfig(aliasRoot));
    await aliasService.initialize();
    const throughAlias = await aliasService.getItem(item.id);
    expect(throughAlias.filePath.startsWith(path.join(aliasRoot, "library", "items"))).toBe(true);

    await aliasService.updateReading(item.id, "reading", 0.5, throughAlias.revision);
    const throughOriginal = await service.getItem(item.id);
    expect(throughOriginal.reading).toMatchObject({ status: "reading", progress: 0.5 });

    const row = database.db.prepare("SELECT file_path FROM items WHERE id = ?").get(item.id) as {
      file_path: string;
    };
    expect(row.file_path).toBe(
      path.relative(config.itemsDir, item.filePath).split(path.sep).join("/"),
    );
  });

  it("recovers from and repairs a foreign absolute index path", async () => {
    const { service, database, item } = await fixture();
    database.db
      .prepare("UPDATE items SET file_path = ? WHERE id = ?")
      .run(`/different-runtime/library/items/2026/${path.basename(item.filePath)}`, item.id);

    const recovered = await service.getItem(item.id);
    expect(recovered.id).toBe(item.id);
    const row = database.db.prepare("SELECT file_path FROM items WHERE id = ?").get(item.id) as {
      file_path: string;
    };
    expect(row.file_path).toBe(`2026/${path.basename(item.filePath)}`);
  });

  it("ignores unsafe indexed paths and falls back to canonical Markdown", async () => {
    const { service, database, item } = await fixture();
    database.db
      .prepare("UPDATE items SET file_path = ? WHERE id = ?")
      .run("../../outside.md", item.id);

    await expect(service.getItem(item.id)).resolves.toMatchObject({ id: item.id });
  });
});
