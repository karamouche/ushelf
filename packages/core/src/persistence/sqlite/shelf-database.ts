import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ingestionState } from "../../domain/ingestion-state.js";
import type {
  IngestionState,
  ItemSummary,
  LibraryListQuery,
  ShelfItem,
} from "../../domain/library-item.js";

const SCHEMA_VERSION = 1;

export class ShelfDatabase {
  readonly db: DatabaseSync;
  readonly itemsDir: string | undefined;

  constructor(databasePath: string, itemsDir?: string) {
    mkdirSync(path.dirname(databasePath), { recursive: true });
    this.itemsDir = itemsDir ? path.resolve(itemsDir) : undefined;
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.initializeSchema();
  }

  private initializeSchema(): void {
    const version = this.schemaVersion();
    if (version > SCHEMA_VERSION) {
      throw new Error(
        `The uShelf index schema is newer than this version supports (${version} > ${SCHEMA_VERSION})`,
      );
    }

    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (version < SCHEMA_VERSION && this.hasManagedSchema()) this.dropSchema();
      this.createSchema();
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private schemaVersion(): number {
    const row = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    return row.user_version;
  }

  private hasManagedSchema(): boolean {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE name IN ('items', 'item_search', 'delete_tokens') LIMIT 1",
        )
        .get(),
    );
  }

  private dropSchema(): void {
    this.db.exec(`
      DROP TABLE IF EXISTS item_search;
      DROP TABLE IF EXISTS items;
      DROP TABLE IF EXISTS delete_tokens;
    `);
  }

  private createSchema(): void {
    this.db.exec(`
        CREATE TABLE IF NOT EXISTS items (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          canonical_url TEXT UNIQUE,
          source_hash TEXT,
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
        CREATE UNIQUE INDEX IF NOT EXISTS items_source_hash ON items(source_hash) WHERE source_hash IS NOT NULL;
        CREATE VIRTUAL TABLE IF NOT EXISTS item_search USING fts5(
          id UNINDEXED, title, source, insights, tags, tokenize='porter unicode61'
        );
        CREATE TABLE IF NOT EXISTS delete_tokens (
          token TEXT PRIMARY KEY,
          item_id TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        );
      `);
  }

  upsert(item: ShelfItem): void {
    const state = ingestionState(item);
    this.transaction(() => {
      this.db
        .prepare(
          `
        INSERT INTO items (id,title,canonical_url,source_hash,source_type,author,captured_at,updated_at,status,progress,tags_json,ingestion_state,summary,file_path,revision)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          title=excluded.title, canonical_url=excluded.canonical_url, source_hash=excluded.source_hash, source_type=excluded.source_type,
          author=excluded.author, captured_at=excluded.captured_at, updated_at=excluded.updated_at,
          status=excluded.status, progress=excluded.progress, tags_json=excluded.tags_json,
          ingestion_state=excluded.ingestion_state, summary=excluded.summary,
          file_path=excluded.file_path, revision=excluded.revision
      `,
        )
        .run(
          item.id,
          item.title,
          item.sourceType === "document" ? null : item.canonicalUrl,
          item.sourceType === "document" ? item.file.sha256 : null,
          item.sourceType,
          item.author ?? null,
          item.capturedAt,
          item.updatedAt,
          item.reading.status,
          item.reading.progress,
          JSON.stringify(item.tags),
          state,
          item.enrichment.summary ?? null,
          this.encodeFilePath(item.filePath),
          item.revision,
        );
      this.db.prepare("DELETE FROM item_search WHERE id = ?").run(item.id);
      this.db
        .prepare("INSERT INTO item_search (id,title,source,insights,tags) VALUES (?,?,?,?,?)")
        .run(item.id, item.title, item.sourceMarkdown, item.insightMarkdown, item.tags.join(" "));
    });
  }

  clearIndex(): void {
    this.db.exec("DELETE FROM item_search; DELETE FROM items;");
  }

  indexedCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM items").get() as { count: number };
    return row.count;
  }

  indexedIds(): string[] {
    return (this.db.prepare("SELECT id FROM items").all() as Array<{ id: string }>).map(
      (row) => row.id,
    );
  }

  delete(id: string): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM item_search WHERE id = ?").run(id);
      this.db.prepare("DELETE FROM items WHERE id = ?").run(id);
      this.db.prepare("DELETE FROM delete_tokens WHERE item_id = ?").run(id);
    });
  }

  findByCanonicalUrl(url: string): string | undefined {
    const row = this.db.prepare("SELECT id FROM items WHERE canonical_url = ?").get(url) as
      { id: string } | undefined;
    return row?.id;
  }

  findBySourceHash(hash: string): string | undefined {
    const row = this.db.prepare("SELECT id FROM items WHERE source_hash = ?").get(hash) as
      { id: string } | undefined;
    return row?.id;
  }

  itemLocation(id: string): { filePath?: string; portable: boolean } | undefined {
    const row = this.db.prepare("SELECT file_path FROM items WHERE id = ?").get(id) as
      { file_path: string } | undefined;
    if (!row) return undefined;
    const filePath = this.decodeFilePath(row.file_path);
    return {
      ...(filePath ? { filePath } : {}),
      portable:
        this.itemsDir === undefined || (!path.isAbsolute(row.file_path) && filePath !== undefined),
    };
  }

  hasItem(id: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM items WHERE id = ?").get(id));
  }

  list(query: LibraryListQuery = {}): ItemSummary[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    let join = "";
    if (query.query?.trim()) {
      join = "JOIN item_search s ON s.id = i.id";
      clauses.push("item_search MATCH ?");
      params.push(toFtsQuery(query.query));
    }
    if (query.status) {
      clauses.push("i.status = ?");
      params.push(query.status);
    }
    if (query.sourceType) {
      clauses.push("i.source_type = ?");
      params.push(query.sourceType);
    }
    if (query.tag) {
      clauses.push("i.tags_json LIKE ?");
      params.push(`%\"${query.tag.replaceAll("%", "")}\"%`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(Math.min(query.limit ?? 50, 200), query.offset ?? 0);
    const rows = this.db
      .prepare(
        `
      SELECT i.* FROM items i ${join} ${where}
      ORDER BY i.captured_at DESC LIMIT ? OFFSET ?
    `,
      )
      .all(...params) as unknown as DatabaseItemRow[];
    return rows.map(rowToSummary);
  }

  createDeleteToken(token: string, itemId: string, expiresAt: number): void {
    this.db.prepare("DELETE FROM delete_tokens WHERE expires_at < ?").run(Date.now());
    this.db
      .prepare("INSERT INTO delete_tokens (token,item_id,expires_at) VALUES (?,?,?)")
      .run(token, itemId, expiresAt);
  }

  consumeDeleteToken(token: string, itemId: string): boolean {
    const row = this.db
      .prepare("SELECT item_id, expires_at FROM delete_tokens WHERE token = ?")
      .get(token) as { item_id: string; expires_at: number } | undefined;
    this.db.prepare("DELETE FROM delete_tokens WHERE token = ?").run(token);
    return row?.item_id === itemId && row.expires_at >= Date.now();
  }

  private transaction(operation: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      operation();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private encodeFilePath(filePath: string): string {
    if (!this.itemsDir) return filePath;
    const relative = path.relative(this.itemsDir, path.resolve(filePath));
    if (
      !relative ||
      path.isAbsolute(relative) ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`)
    )
      throw new Error(`Item path is outside the library: ${filePath}`);
    return relative.split(path.sep).join(path.posix.sep);
  }

  private decodeFilePath(storedPath: string): string | undefined {
    if (!this.itemsDir) return storedPath;
    if (path.isAbsolute(storedPath)) {
      const resolved = path.resolve(storedPath);
      return isWithin(this.itemsDir, resolved) ? resolved : undefined;
    }
    const parts = storedPath.split("/");
    if (parts.some((part) => !part || part === "." || part === "..")) return undefined;
    const resolved = path.resolve(this.itemsDir, ...parts);
    return isWithin(this.itemsDir, resolved) ? resolved : undefined;
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    Boolean(relative) &&
    !path.isAbsolute(relative) &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`)
  );
}

interface DatabaseItemRow {
  id: string;
  title: string;
  canonical_url: string | null;
  source_hash: string | null;
  source_type: "article" | "document" | "x";
  author: string | null;
  captured_at: string;
  updated_at: string;
  status: "inbox" | "reading" | "read" | "archived";
  progress: number;
  tags_json: string;
  ingestion_state: IngestionState;
  summary: string | null;
}

function rowToSummary(row: DatabaseItemRow): ItemSummary {
  return {
    id: row.id,
    title: row.title,
    sourceType: row.source_type,
    ...(row.canonical_url ? { canonicalUrl: row.canonical_url } : {}),
    ...(row.author ? { author: row.author } : {}),
    capturedAt: row.captured_at,
    updatedAt: row.updated_at,
    status: row.status,
    progress: row.progress,
    tags: JSON.parse(row.tags_json) as string[],
    ingestionState: row.ingestion_state,
    ...(row.summary ? { summary: row.summary } : {}),
  };
}

function toFtsQuery(value: string): string {
  const tokens = value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return tokens.length ? tokens.map((token) => `"${token}"*`).join(" AND ") : '""';
}
