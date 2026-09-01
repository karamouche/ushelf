import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ShelfDatabase } from "./shelf-database.js";

const roots: string[] = [];

afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

describe("ShelfDatabase schema", () => {
  it("recreates an unversioned legacy index with the current schema", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ushelf-database-test-"));
    roots.push(root);
    const databasePath = path.join(root, "ushelf.db");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE items (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        canonical_url TEXT NOT NULL UNIQUE,
        source_type TEXT NOT NULL,
        author TEXT,
        captured_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        status TEXT NOT NULL,
        progress REAL NOT NULL,
        tags_json TEXT NOT NULL,
        ingestion_state TEXT NOT NULL,
        summary TEXT,
        file_path TEXT NOT NULL,
        revision TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE item_search USING fts5(
        id UNINDEXED, title, source, insights, tags, tokenize='porter unicode61'
      );
      CREATE TABLE delete_tokens (
        token TEXT PRIMARY KEY,
        item_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
    legacy.close();

    const database = new ShelfDatabase(databasePath, path.join(root, "library", "items"));
    const columns = database.db.prepare("PRAGMA table_info(items)").all() as Array<{
      name: string;
      notnull: number;
    }>;
    const version = database.db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };

    expect(version.user_version).toBe(1);
    expect(columns.find((column) => column.name === "source_hash")).toBeDefined();
    expect(columns.find((column) => column.name === "canonical_url")?.notnull).toBe(0);
    database.db.close();
  });
});
