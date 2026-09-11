import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { ShelfItem } from "../../domain/library-item.js";
import { ShelfDatabase } from "./shelf-database.js";

const roots: string[] = [];

afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ushelf-database-test-"));
  roots.push(root);
  const databasePath = path.join(root, "state", "ushelf.db");
  const itemsDir = path.join(root, "library", "items");
  await mkdir(path.join(itemsDir, "2026"), { recursive: true });
  return {
    databasePath,
    itemsDir,
    database: new ShelfDatabase(databasePath, itemsDir),
  };
}

function article(itemsDir: string, overrides: Partial<ShelfItem> = {}): ShelfItem {
  const id = "42ff9bd4-00a8-48e7-863f-279d828154e8";
  return {
    id,
    originalUrl: "https://example.com/article",
    canonicalUrl: "https://example.com/article",
    sourceType: "article",
    title: "A maintainable SQLite architecture",
    author: "Ada",
    capturedAt: "2026-08-19T12:00:00.000Z",
    updatedAt: "2026-08-20T12:00:00.000Z",
    reading: { status: "reading", progress: 0.4 },
    tags: ["sqlite", "architecture"],
    extraction: {
      status: "complete",
      method: "readability",
      retrievedAt: "2026-08-19T12:00:00.000Z",
      contentHash: "source-hash",
    },
    enrichment: {
      status: "complete",
      recipe: "default",
      summary: "A concise database summary.",
    },
    media: {
      source: { discovered: 0, localized: 0, omitted: 0, filtered: 0 },
      insights: { discovered: 0, localized: 0, omitted: 0, filtered: 0 },
    },
    filePath: path.join(itemsDir, "2026", `${id}.md`),
    sourceMarkdown: "Typed queries make the architecture maintainable.",
    insightMarkdown: "Drizzle keeps the SQL visible.",
    revision: "revision-1",
    ...overrides,
  } as ShelfItem;
}

function document(itemsDir: string): ShelfItem {
  const id = "013ec14f-d8c4-4f59-8092-2ee8a77806ac";
  return {
    id,
    sourceType: "document",
    title: "SQLite paper",
    capturedAt: "2026-08-18T12:00:00.000Z",
    updatedAt: "2026-08-18T12:00:00.000Z",
    reading: { status: "inbox", progress: 0 },
    tags: ["paper"],
    extraction: {
      status: "complete",
      method: "pdf_text",
      retrievedAt: "2026-08-18T12:00:00.000Z",
      contentHash: "document-content",
    },
    enrichment: { status: "pending", recipe: "default" },
    media: {
      source: { discovered: 0, localized: 0, omitted: 0, filtered: 0 },
      insights: { discovered: 0, localized: 0, omitted: 0, filtered: 0 },
    },
    file: {
      name: "sqlite.pdf",
      mediaType: "application/pdf",
      sizeBytes: 1024,
      sha256: "a".repeat(64),
      pageCount: 2,
    },
    filePath: path.join(itemsDir, "2026", `${id}.md`),
    sourceMarkdown: "A paper about full text search.",
    insightMarkdown: "",
    revision: "revision-2",
  };
}

describe("ShelfDatabase", () => {
  it("applies the relational and FTS5 migration baseline exactly once", async () => {
    const { databasePath, itemsDir, database } = await fixture();
    database.close();

    const sqlite = new BetterSqlite3(databasePath);
    const objects = sqlite
      .prepare(
        "SELECT name, type FROM sqlite_master WHERE name IN ('items', 'items_source_hash', 'item_search', 'delete_tokens', 'kindle_delivery_claims', 'kindle_preferences', '__drizzle_migrations') ORDER BY name",
      )
      .all();
    const appliedBefore = sqlite
      .prepare("SELECT COUNT(*) AS count FROM __drizzle_migrations")
      .get() as { count: number };
    sqlite.close();

    expect(objects).toEqual([
      { name: "__drizzle_migrations", type: "table" },
      { name: "delete_tokens", type: "table" },
      { name: "item_search", type: "table" },
      { name: "items", type: "table" },
      { name: "items_source_hash", type: "index" },
      { name: "kindle_delivery_claims", type: "table" },
      { name: "kindle_preferences", type: "table" },
    ]);
    expect(appliedBefore.count).toBe(4);

    const reopened = new ShelfDatabase(databasePath, itemsDir);
    reopened.close();
    const verification = new BetterSqlite3(databasePath, { readonly: true });
    const appliedAfter = verification
      .prepare("SELECT COUNT(*) AS count FROM __drizzle_migrations")
      .get() as { count: number };
    verification.close();
    expect(appliedAfter.count).toBe(4);
  });

  it("provides typed CRUD, filtering, FTS, path, and delete-token behavior", async () => {
    const { databasePath, database, itemsDir } = await fixture();
    const savedArticle = article(itemsDir);
    const savedDocument = document(itemsDir);

    database.upsert(savedArticle);
    database.upsert(savedDocument);

    expect(database.indexedCount()).toBe(2);
    expect(database.indexedIds()).toEqual(
      expect.arrayContaining([savedArticle.id, savedDocument.id]),
    );
    expect(database.findByCanonicalUrl("https://example.com/article")).toBe(savedArticle.id);
    expect(database.findBySourceHash("a".repeat(64))).toBe(savedDocument.id);
    expect(database.itemLocation(savedArticle.id)).toEqual({
      filePath: savedArticle.filePath,
      portable: true,
    });
    expect(database.list({ status: "reading", sourceType: "article", tag: "sqlite" })).toEqual([
      expect.objectContaining({ id: savedArticle.id, tags: ["sqlite", "architecture"] }),
    ]);
    expect(database.list({ query: "maintainable architecture" })).toEqual([
      expect.objectContaining({ id: savedArticle.id }),
    ]);
    expect(database.list({ query: "full text" })).toEqual([
      expect.objectContaining({ id: savedDocument.id }),
    ]);

    database.upsert(
      article(itemsDir, {
        title: "Updated title",
        updatedAt: "2026-08-21T12:00:00.000Z",
        revision: "revision-3",
      }),
    );
    expect(database.list({ sourceType: "article" })).toEqual([
      expect.objectContaining({ id: savedArticle.id, title: "Updated title" }),
    ]);

    database.createDeleteToken("valid", savedArticle.id, Date.now() + 60_000);
    expect(database.consumeDeleteToken("valid", savedArticle.id)).toBe(true);
    expect(database.consumeDeleteToken("valid", savedArticle.id)).toBe(false);
    database.createDeleteToken("expired", savedDocument.id, Date.now() - 1);
    expect(database.consumeDeleteToken("expired", savedDocument.id)).toBe(false);

    expect(database.lastUsedKindleDeviceSerial()).toBeUndefined();
    database.setLastUsedKindleDeviceSerial("DEVICE123");
    expect(database.lastUsedKindleDeviceSerial()).toBe("DEVICE123");

    database.delete(savedArticle.id);
    expect(database.hasItem(savedArticle.id)).toBe(false);
    expect(database.list({ query: "maintainable" })).toEqual([]);
    database.clearIndex();
    expect(database.indexedCount()).toBe(0);
    expect(database.lastUsedKindleDeviceSerial()).toBe("DEVICE123");
    database.close();

    const reopened = new ShelfDatabase(databasePath, itemsDir);
    expect(reopened.lastUsedKindleDeviceSerial()).toBe("DEVICE123");
    reopened.close();
  });

  it("keeps canonical URL and document hash uniqueness transactional", async () => {
    const { database, itemsDir } = await fixture();
    const savedArticle = article(itemsDir);
    database.upsert(savedArticle);

    expect(() =>
      database.upsert(
        article(itemsDir, {
          id: "09a0f636-5227-468f-a70a-9a19579d2e4a",
          filePath: path.join(itemsDir, "2026", "09a0f636-5227-468f-a70a-9a19579d2e4a.md"),
        }),
      ),
    ).toThrow();
    expect(database.indexedCount()).toBe(1);
    expect(database.list({ query: "maintainable" })).toHaveLength(1);
    database.close();
  });

  it("claims Kindle delivery atomically across instances and reclaims expired leases", async () => {
    const { databasePath, database, itemsDir } = await fixture();
    const otherDatabase = new ShelfDatabase(databasePath, itemsDir);
    const itemId = "42ff9bd4-00a8-48e7-863f-279d828154e8";

    expect(database.claimKindleDelivery(itemId, "DEVICE123", "first", 2_000, 1_000)).toBe(true);
    expect(otherDatabase.claimKindleDelivery(itemId, "DEVICE123", "second", 3_000, 1_000)).toBe(
      false,
    );
    expect(otherDatabase.claimKindleDelivery(itemId, "DEVICE123", "second", 4_000, 2_000)).toBe(
      true,
    );

    database.releaseKindleDelivery(itemId, "DEVICE123", "first");
    expect(database.claimKindleDelivery(itemId, "DEVICE123", "third", 5_000, 2_001)).toBe(false);
    otherDatabase.releaseKindleDelivery(itemId, "DEVICE123", "second");
    expect(database.claimKindleDelivery(itemId, "DEVICE123", "third", 5_000, 2_001)).toBe(true);

    otherDatabase.close();
    database.close();
  });
});
