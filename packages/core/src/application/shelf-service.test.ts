import { mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
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
    schemaVersion: 2,
    id: "e7cf9d0d-bba8-4b93-9503-ab8f15de9d2f",
    originalUrl: "https://x.com/a/status/1",
    canonicalUrl: "https://x.com/a/status/1",
    sourceType: "x",
    title: "Pending thread",
    capturedAt: now,
    updatedAt: now,
    reading: { status: "inbox", progress: 0 },
    tags: [],
    extraction: { status: "pending" },
    enrichment: { status: "pending", recipe: "default" },
    media: {
      source: { discovered: 0, localized: 0, omitted: 0, filtered: 0 },
      insights: { discovered: 0, localized: 0, omitted: 0, filtered: 0 },
    },
  };
  const item = await repository.save(frontmatter, "", "");
  database.upsert(item);
  return { root, config, service, database, item };
}

describe("agent-driven workflow", () => {
  it("does not retain a file or item when PDF extraction fails", async () => {
    const { config, service } = await fixture();
    const before = service.listItems().length;
    await expect(
      service.ingestFile({
        filename: "broken.pdf",
        contentBase64: Buffer.from("%PDF-1.4\nbroken").toString("base64"),
      }),
    ).rejects.toThrow();
    expect(service.listItems()).toHaveLength(before);
    expect(await readdir(config.filesDir)).toEqual([]);
  });

  it("ingests, deduplicates, cites, serves, and deletes a PDF document", async () => {
    const { config, service } = await fixture();
    const first = await service.ingestFile({
      filename: "useful-paper.pdf",
      contentBase64: SIMPLE_PDF_BASE64,
    });

    expect(first).toMatchObject({ duplicate: false, state: "awaiting_enrichment" });
    expect(first.item).toMatchObject({
      schemaVersion: 2,
      sourceType: "document",
      title: "useful-paper",
      file: { name: "useful-paper.pdf", mediaType: "application/pdf", pageCount: 1 },
      extraction: { status: "complete", method: "pdf_text" },
    });
    expect(first.item.sourceMarkdown).toContain("## Page 1");
    expect(first.item.sourceMarkdown).toContain("deterministic extraction");
    expect(await readFile(path.join(config.filesDir, first.item.id, "original.pdf"))).toEqual(
      Buffer.from(SIMPLE_PDF_BASE64, "base64"),
    );

    const duplicate = await service.ingestFile({
      filename: "renamed.pdf",
      contentBase64: SIMPLE_PDF_BASE64,
    });
    expect(duplicate).toMatchObject({ duplicate: true, item: { id: first.item.id } });

    const context = await service.ingestionContext(first.item.id);
    expect(context.outputContract).toMatchObject({
      citations: "{page,label}[] using page numbers present in the document",
    });
    const enriched = await service.saveInsights({
      itemId: first.item.id,
      recipeHash: context.recipe.hash,
      revision: first.item.revision,
      summary: "A PDF summary.",
      keyPoints: ["A page-grounded point"],
      tags: ["Documents"],
      citations: [{ page: 1, label: "The extracted page" }],
      bodyMarkdown: "",
    });
    expect(await readFile(enriched.filePath, "utf8")).toContain("- Page 1 — The extracted page");
    await expect(
      service.saveInsights({
        itemId: first.item.id,
        recipeHash: context.recipe.hash,
        revision: enriched.revision,
        summary: "Invalid citation.",
        keyPoints: ["Point"],
        tags: [],
        citations: [{ url: "https://example.com", label: "Wrong citation kind" }],
        bodyMarkdown: "",
      }),
    ).rejects.toThrow(/must use page numbers/);
    await expect(
      service.saveInsights({
        itemId: first.item.id,
        recipeHash: context.recipe.hash,
        revision: enriched.revision,
        summary: "Invalid citation.",
        keyPoints: ["Point"],
        tags: [],
        citations: [{ page: 2, label: "Outside" }],
        bodyMarkdown: "",
      }),
    ).rejects.toThrow(/outside the document/);
    await expect(service.refreshSource(first.item.id)).rejects.toThrow(/cannot be refreshed/);

    const original = await service.getOriginalFile(first.item.id);
    expect(original.name).toBe("useful-paper.pdf");
    expect(original.bytes).toEqual(Buffer.from(SIMPLE_PDF_BASE64, "base64"));
    const deletion = service.requestDelete(first.item.id);
    await service.confirmDelete(first.item.id, deletion.token);
    await expect(service.getOriginalFile(first.item.id)).rejects.toThrow(/not found/i);
  });

  it("resumes source fallback, saves insights, persists reading state, and rebuilds from Markdown", async () => {
    const { config, service, database, item } = await fixture();
    const sourceUrl = "https://x.com/a/status/1";
    const sourced = await service.submitSourceContent({
      itemId: item.id,
      title: "A useful thread",
      markdown: `First post with enough detail to be useful.\n\n![Chart](${PNG_DATA_URL})\n\n[Original](${sourceUrl})`,
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
      bodyMarkdown: `### Why it matters\n\nIt proves the workflow.\n\n![Chart again](${PNG_DATA_URL})`,
    });
    expect(ready.enrichment.status).toBe("complete");
    expect(ready.tags).toEqual(["testing"]);
    expect(ready.sourceMarkdown).not.toContain("data:image");
    expect(ready.insightMarkdown).not.toContain("data:image");
    expect(ready.media.source).toMatchObject({ discovered: 1, localized: 1, omitted: 0 });
    expect(ready.media.insights).toMatchObject({ discovered: 1, localized: 1, omitted: 0 });
    expect(await readdir(path.join(config.filesDir, item.id, "media"))).toHaveLength(1);
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

const SIMPLE_PDF_BASE64 =
  "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA0IDAgUiA+PiA+PiAvQ29udGVudHMgNSAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iago1IDAgb2JqCjw8IC9MZW5ndGggMTIwID4+CnN0cmVhbQpCVAovRjEgMTIgVGYKNzIgNzIwIFRkCihBIHVzZWZ1bCBQREYgZG9jdW1lbnQgd2l0aCBlbm91Z2ggZW1iZWRkZWQgdGV4dCBmb3IgZGV0ZXJtaW5pc3RpYyBleHRyYWN0aW9uIGFuZCB0ZXN0aW5nLikgVGoKRVQKZW5kc3RyZWFtCmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTE1IDAwMDAwIG4gCjAwMDAwMDAyNDEgMDAwMDAgbiAKMDAwMDAwMDMxMSAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDYgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjQ4MgolJUVPRgo=";

const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n3sAAAAASUVORK5CYII=";
