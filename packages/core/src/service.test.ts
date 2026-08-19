import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveConfig } from "./config.js";
import { sha256 } from "./markdown.js";
import { ShelfService } from "./service.js";
import type { ItemFrontmatter } from "./types.js";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ushelf-test-"));
  roots.push(root);
  const config = resolveConfig(root);
  const service = new ShelfService(config);
  await service.repository.initialize();
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
  const item = await service.repository.save(frontmatter, "", "");
  service.database.upsert(item);
  return { root, config, service, item };
}

describe("agent-driven workflow", () => {
  it("resumes source fallback, saves insights, persists reading state, and rebuilds from Markdown", async () => {
    const { config, service, item } = await fixture();
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
    service.database.clearIndex();
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
});
