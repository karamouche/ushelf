import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import BetterSqlite3 from "better-sqlite3";
import {
  and,
  count,
  desc,
  eq,
  getTableColumns,
  isNotNull,
  lte,
  lt,
  max,
  notExists,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { ingestionState } from "../../domain/ingestion-state.js";
import type { ItemSummary, LibraryListQuery, ShelfItem } from "../../domain/library-item.js";
import { itemSearch } from "./item-search.js";
import {
  deleteTokens,
  items,
  kindleDeliveryClaims,
  kindlePreferences,
  oauthAuthorizationCodes,
  oauthClients,
  oauthGrants,
} from "./schema.js";
import * as schema from "./schema.js";

const migrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));

export class ShelfDatabase {
  private readonly sqlite: BetterSqlite3.Database;
  private readonly database: BetterSQLite3Database<typeof schema>;
  private readonly itemsDir: string | undefined;

  constructor(databasePath: string, itemsDir?: string) {
    mkdirSync(path.dirname(databasePath), { recursive: true });
    this.itemsDir = itemsDir ? path.resolve(itemsDir) : undefined;
    this.sqlite = new BetterSqlite3(databasePath);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("foreign_keys = ON");
    this.database = drizzle(this.sqlite, { schema });
    migrate(this.database, { migrationsFolder });
  }

  close(): void {
    this.sqlite.close();
  }

  upsert(item: ShelfItem): void {
    const values = {
      id: item.id,
      title: item.title,
      canonicalUrl: item.sourceType === "document" ? null : item.canonicalUrl,
      sourceHash: item.sourceType === "document" ? item.file.sha256 : null,
      sourceType: item.sourceType,
      author: item.author ?? null,
      capturedAt: item.capturedAt,
      updatedAt: item.updatedAt,
      status: item.reading.status,
      progress: item.reading.progress,
      tags: item.tags,
      ingestionState: ingestionState(item),
      summary: item.enrichment.summary ?? null,
      filePath: this.encodeFilePath(item.filePath),
      revision: item.revision,
    };

    this.database.transaction((transaction) => {
      transaction
        .insert(items)
        .values(values)
        .onConflictDoUpdate({
          target: items.id,
          set: {
            title: values.title,
            canonicalUrl: values.canonicalUrl,
            sourceHash: values.sourceHash,
            sourceType: values.sourceType,
            author: values.author,
            capturedAt: values.capturedAt,
            updatedAt: values.updatedAt,
            status: values.status,
            progress: values.progress,
            tags: values.tags,
            ingestionState: values.ingestionState,
            summary: values.summary,
            filePath: values.filePath,
            revision: values.revision,
          },
        })
        .run();
      transaction.delete(itemSearch).where(eq(itemSearch.id, item.id)).run();
      transaction
        .insert(itemSearch)
        .values({
          id: item.id,
          title: item.title,
          source: item.sourceMarkdown,
          insights: item.insightMarkdown,
          tags: item.tags.join(" "),
        })
        .run();
    });
  }

  clearIndex(): void {
    this.database.transaction((transaction) => {
      transaction.delete(itemSearch).run();
      transaction.delete(items).run();
    });
  }

  indexedCount(): number {
    return this.database.select({ value: count() }).from(items).get()?.value ?? 0;
  }

  indexedIds(): string[] {
    return this.database
      .select({ id: items.id })
      .from(items)
      .all()
      .map((row) => row.id);
  }

  delete(id: string): void {
    this.database.transaction((transaction) => {
      transaction.delete(itemSearch).where(eq(itemSearch.id, id)).run();
      transaction.delete(items).where(eq(items.id, id)).run();
      transaction.delete(deleteTokens).where(eq(deleteTokens.itemId, id)).run();
    });
  }

  findByCanonicalUrl(url: string): string | undefined {
    return this.database
      .select({ id: items.id })
      .from(items)
      .where(eq(items.canonicalUrl, url))
      .get()?.id;
  }

  findBySourceHash(hash: string): string | undefined {
    return this.database
      .select({ id: items.id })
      .from(items)
      .where(eq(items.sourceHash, hash))
      .get()?.id;
  }

  itemLocation(id: string): { filePath?: string; portable: boolean } | undefined {
    const row = this.database
      .select({ filePath: items.filePath })
      .from(items)
      .where(eq(items.id, id))
      .get();
    if (!row) return undefined;
    const filePath = this.decodeFilePath(row.filePath);
    return {
      ...(filePath ? { filePath } : {}),
      portable:
        this.itemsDir === undefined || (!path.isAbsolute(row.filePath) && filePath !== undefined),
    };
  }

  hasItem(id: string): boolean {
    return Boolean(
      this.database.select({ id: items.id }).from(items).where(eq(items.id, id)).get(),
    );
  }

  list(query: LibraryListQuery = {}): ItemSummary[] {
    const conditions: SQL[] = [];
    if (query.status) conditions.push(eq(items.status, query.status));
    if (query.sourceType) conditions.push(eq(items.sourceType, query.sourceType));
    if (query.tag) {
      conditions.push(sql`${items.tags} LIKE ${`%\"${query.tag.replaceAll("%", "")}\"%`}`);
    }

    const limit = Math.min(query.limit ?? 50, 200);
    const offset = query.offset ?? 0;
    const columns = getTableColumns(items);
    const search = query.query?.trim();
    const rows = search
      ? this.database
          .select(columns)
          .from(items)
          .innerJoin(itemSearch, eq(itemSearch.id, items.id))
          .where(and(sql`${itemSearch} MATCH ${toFtsQuery(search)}`, ...conditions))
          .orderBy(desc(items.capturedAt))
          .limit(limit)
          .offset(offset)
          .all()
      : this.database
          .select(columns)
          .from(items)
          .where(conditions.length ? and(...conditions) : undefined)
          .orderBy(desc(items.capturedAt))
          .limit(limit)
          .offset(offset)
          .all();
    return rows.map(rowToSummary);
  }

  createDeleteToken(token: string, itemId: string, expiresAt: number): void {
    this.database.transaction((transaction) => {
      transaction.delete(deleteTokens).where(lt(deleteTokens.expiresAt, Date.now())).run();
      transaction.insert(deleteTokens).values({ token, itemId, expiresAt }).run();
    });
  }

  consumeDeleteToken(token: string, itemId: string): boolean {
    return this.database.transaction((transaction) => {
      const row = transaction
        .select({ itemId: deleteTokens.itemId, expiresAt: deleteTokens.expiresAt })
        .from(deleteTokens)
        .where(eq(deleteTokens.token, token))
        .get();
      transaction.delete(deleteTokens).where(eq(deleteTokens.token, token)).run();
      return row?.itemId === itemId && row.expiresAt >= Date.now();
    });
  }

  lastUsedKindleDeviceSerial(): string | undefined {
    return this.database
      .select({ lastUsedDeviceSerial: kindlePreferences.lastUsedDeviceSerial })
      .from(kindlePreferences)
      .where(eq(kindlePreferences.id, 1))
      .get()?.lastUsedDeviceSerial;
  }

  setLastUsedKindleDeviceSerial(lastUsedDeviceSerial: string): void {
    this.database
      .insert(kindlePreferences)
      .values({ id: 1, lastUsedDeviceSerial })
      .onConflictDoUpdate({
        target: kindlePreferences.id,
        set: { lastUsedDeviceSerial },
      })
      .run();
  }

  claimKindleDelivery(
    itemId: string,
    targetSerial: string,
    claimToken: string,
    expiresAt: number,
    now = Date.now(),
  ): boolean {
    const claimed = this.database
      .insert(kindleDeliveryClaims)
      .values({ itemId, targetSerial, claimToken, expiresAt })
      .onConflictDoUpdate({
        target: [kindleDeliveryClaims.itemId, kindleDeliveryClaims.targetSerial],
        set: { claimToken, expiresAt },
        setWhere: lte(kindleDeliveryClaims.expiresAt, now),
      })
      .returning({ claimToken: kindleDeliveryClaims.claimToken })
      .get();
    return claimed?.claimToken === claimToken;
  }

  releaseKindleDelivery(itemId: string, targetSerial: string, claimToken: string): void {
    this.database
      .delete(kindleDeliveryClaims)
      .where(
        and(
          eq(kindleDeliveryClaims.itemId, itemId),
          eq(kindleDeliveryClaims.targetSerial, targetSerial),
          eq(kindleDeliveryClaims.claimToken, claimToken),
        ),
      )
      .run();
  }

  insertOAuthClient(client: typeof oauthClients.$inferInsert): void {
    this.database.insert(oauthClients).values(client).run();
  }

  oauthClient(clientId: string): typeof oauthClients.$inferSelect | undefined {
    return this.database
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.clientId, clientId))
      .get();
  }

  oauthClientCount(): number {
    return this.database.select({ value: count() }).from(oauthClients).get()?.value ?? 0;
  }

  /** Drops expired codes and grants, then registrations that never completed a grant. */
  purgeOAuth(now: number, abandonedBefore: number): void {
    this.database.transaction((transaction) => {
      transaction
        .delete(oauthAuthorizationCodes)
        .where(lte(oauthAuthorizationCodes.expiresAt, now))
        .run();
      transaction.delete(oauthGrants).where(lte(oauthGrants.refreshExpiresAt, now)).run();
      transaction
        .delete(oauthClients)
        .where(
          and(
            lt(oauthClients.createdAt, abandonedBefore),
            notExists(
              transaction
                .select({ id: oauthGrants.id })
                .from(oauthGrants)
                .where(eq(oauthGrants.clientId, oauthClients.clientId)),
            ),
            notExists(
              transaction
                .select({ codeHash: oauthAuthorizationCodes.codeHash })
                .from(oauthAuthorizationCodes)
                .where(eq(oauthAuthorizationCodes.clientId, oauthClients.clientId)),
            ),
          ),
        )
        .run();
    });
  }

  insertAuthorizationCode(code: typeof oauthAuthorizationCodes.$inferInsert): void {
    this.database.insert(oauthAuthorizationCodes).values(code).run();
  }

  /** Authorization codes are single-use: reading one always deletes it. */
  consumeAuthorizationCode(
    codeHash: string,
  ): typeof oauthAuthorizationCodes.$inferSelect | undefined {
    return this.database
      .delete(oauthAuthorizationCodes)
      .where(eq(oauthAuthorizationCodes.codeHash, codeHash))
      .returning()
      .get();
  }

  insertOAuthGrant(grant: typeof oauthGrants.$inferInsert): void {
    this.database.insert(oauthGrants).values(grant).run();
  }

  oauthGrantByAccessToken(accessTokenHash: string): typeof oauthGrants.$inferSelect | undefined {
    return this.database
      .select()
      .from(oauthGrants)
      .where(eq(oauthGrants.accessTokenHash, accessTokenHash))
      .get();
  }

  /** Finds a grant by its current or most recently rotated-out refresh token. */
  oauthGrantByRefreshToken(
    refreshTokenHash: string,
  ): (typeof oauthGrants.$inferSelect & { replayed: boolean }) | undefined {
    const grant = this.database
      .select()
      .from(oauthGrants)
      .where(
        or(
          eq(oauthGrants.refreshTokenHash, refreshTokenHash),
          and(
            isNotNull(oauthGrants.previousRefreshTokenHash),
            eq(oauthGrants.previousRefreshTokenHash, refreshTokenHash),
          ),
        ),
      )
      .get();
    return grant && { ...grant, replayed: grant.refreshTokenHash !== refreshTokenHash };
  }

  /** Rotates tokens only if the grant still holds the refresh token the caller presented. */
  rotateOAuthGrant(
    id: string,
    presentedRefreshTokenHash: string,
    next: Pick<
      typeof oauthGrants.$inferInsert,
      "accessTokenHash" | "accessExpiresAt" | "refreshTokenHash" | "refreshExpiresAt" | "lastUsedAt"
    >,
  ): boolean {
    const updated = this.database
      .update(oauthGrants)
      .set({ ...next, previousRefreshTokenHash: presentedRefreshTokenHash })
      .where(
        and(eq(oauthGrants.id, id), eq(oauthGrants.refreshTokenHash, presentedRefreshTokenHash)),
      )
      .returning({ id: oauthGrants.id })
      .get();
    return updated !== undefined;
  }

  touchOAuthGrant(id: string, lastUsedAt: number): void {
    this.database.update(oauthGrants).set({ lastUsedAt }).where(eq(oauthGrants.id, id)).run();
  }

  deleteOAuthGrant(id: string): void {
    this.database.delete(oauthGrants).where(eq(oauthGrants.id, id)).run();
  }

  /** Lists registered clients that currently hold at least one grant. */
  oauthConnectors(): Array<{
    clientId: string;
    clientName: string | null;
    redirectUris: string[];
    connectedAt: number;
    lastUsedAt: number;
  }> {
    return this.database
      .select({
        clientId: oauthClients.clientId,
        clientName: oauthClients.clientName,
        redirectUris: oauthClients.redirectUris,
        connectedAt: sql<number>`min(${oauthGrants.createdAt})`.mapWith(Number),
        lastUsedAt: max(oauthGrants.lastUsedAt).mapWith(Number),
      })
      .from(oauthClients)
      .innerJoin(oauthGrants, eq(oauthGrants.clientId, oauthClients.clientId))
      .groupBy(oauthClients.clientId)
      .orderBy(desc(max(oauthGrants.lastUsedAt)))
      .all();
  }

  deleteOAuthClient(clientId: string): boolean {
    return (
      this.database
        .delete(oauthClients)
        .where(eq(oauthClients.clientId, clientId))
        .returning({ clientId: oauthClients.clientId })
        .get() !== undefined
    );
  }

  deleteAllOAuthClients(): number {
    return this.database.delete(oauthClients).returning({ clientId: oauthClients.clientId }).all()
      .length;
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

function rowToSummary(row: typeof items.$inferSelect): ItemSummary {
  return {
    id: row.id,
    title: row.title,
    sourceType: row.sourceType,
    ...(row.canonicalUrl ? { canonicalUrl: row.canonicalUrl } : {}),
    ...(row.author ? { author: row.author } : {}),
    capturedAt: row.capturedAt,
    updatedAt: row.updatedAt,
    status: row.status,
    progress: row.progress,
    tags: row.tags,
    ingestionState: row.ingestionState,
    ...(row.summary ? { summary: row.summary } : {}),
  };
}

function toFtsQuery(value: string): string {
  const tokens = value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return tokens.length ? tokens.map((token) => `"${token}"*`).join(" AND ") : '""';
}
