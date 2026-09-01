import { sqliteTable, text } from "drizzle-orm/sqlite-core";

// Query-only mapping for the FTS5 virtual table created by the custom migration.
// Keep this file outside drizzle.config.ts so Drizzle Kit never emits ordinary
// CREATE TABLE statements for item_search.
export const itemSearch = sqliteTable("item_search", {
  id: text("id"),
  title: text("title"),
  source: text("source"),
  insights: text("insights"),
  tags: text("tags"),
});
