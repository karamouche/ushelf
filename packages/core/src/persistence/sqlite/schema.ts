import { sql } from "drizzle-orm";
import { integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
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

export const kindlePreferences = sqliteTable("kindle_preferences", {
  id: integer("id").primaryKey(),
  lastUsedDeviceSerial: text("last_used_device_serial").notNull(),
});

export const kindleDeliveryClaims = sqliteTable(
  "kindle_delivery_claims",
  {
    itemId: text("item_id").notNull(),
    targetSerial: text("target_serial").notNull(),
    claimToken: text("claim_token").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.itemId, table.targetSerial] })],
);

export const oauthClients = sqliteTable("oauth_clients", {
  clientId: text("client_id").primaryKey(),
  clientSecretHash: text("client_secret_hash"),
  clientName: text("client_name"),
  redirectUris: text("redirect_uris_json", { mode: "json" }).$type<string[]>().notNull(),
  createdAt: integer("created_at").notNull(),
});

export const oauthAuthorizationCodes = sqliteTable("oauth_authorization_codes", {
  codeHash: text("code_hash").primaryKey(),
  clientId: text("client_id")
    .notNull()
    .references(() => oauthClients.clientId, { onDelete: "cascade" }),
  redirectUri: text("redirect_uri").notNull(),
  codeChallenge: text("code_challenge").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

export const oauthGrants = sqliteTable("oauth_grants", {
  id: text("id").primaryKey(),
  clientId: text("client_id")
    .notNull()
    .references(() => oauthClients.clientId, { onDelete: "cascade" }),
  accessTokenHash: text("access_token_hash").notNull().unique(),
  accessExpiresAt: integer("access_expires_at").notNull(),
  refreshTokenHash: text("refresh_token_hash").notNull().unique(),
  previousRefreshTokenHash: text("previous_refresh_token_hash").unique(),
  refreshExpiresAt: integer("refresh_expires_at").notNull(),
  createdAt: integer("created_at").notNull(),
  lastUsedAt: integer("last_used_at").notNull(),
});
