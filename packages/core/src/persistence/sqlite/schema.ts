import { sql } from "drizzle-orm";
import { integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { IngestionState, ReadingStatus, SourceType } from "../../domain/library-item.js";

export const items = sqliteTable(
  "items",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    canonicalUrl: text("canonical_url").unique(),
    sourceHash: text("source_hash"),
    sourceType: text("source_type").$type<SourceType>().notNull(),
    author: text("author"),
    capturedAt: text("captured_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    status: text("status").$type<ReadingStatus>().notNull(),
    progress: real("progress").notNull(),
    tags: text("tags_json", { mode: "json" }).$type<string[]>().notNull(),
    ingestionState: text("ingestion_state").$type<IngestionState>().notNull(),
    summary: text("summary"),
    filePath: text("file_path").notNull(),
    revision: text("revision").notNull(),
  },
  (table) => [
    uniqueIndex("items_source_hash")
      .on(table.sourceHash)
      .where(sql`${table.sourceHash} IS NOT NULL`),
  ],
);

export const deleteTokens = sqliteTable("delete_tokens", {
  token: text("token").primaryKey(),
  itemId: text("item_id").notNull(),
  expiresAt: integer("expires_at").notNull(),
});
