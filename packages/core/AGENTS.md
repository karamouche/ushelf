# Core Agent Guide

This guide applies to `packages/core`. Read the repository `AGENTS.md`, root `README.md`, and this package's `README.md` before editing.

## Purpose and boundary

`@ushelf/core` owns uShelf's domain behavior and durable-data rules. Both `apps/server` and `apps/mcp` depend on it. Put behavior here when it must be identical across adapters: ingestion, URL safety, workflows, validation, Markdown persistence, recipes, indexing, concurrency, and deletion.

`ShelfService` is the application boundary. Adapters should import public values from `src/index.ts` and should not reach into Core internals. Keep repositories, codecs, extractors, and SQLite implementation details private unless a deliberate public API change requires otherwise.

## Source map

- `src/application/shelf-service.ts`: coordinates complete use cases and keeps Markdown and SQLite synchronized.
- `src/domain`: Zod-backed item schemas, public types, and ingestion-state derivation.
- `src/ingestion`: URL canonicalization, SSRF-safe fetching, article extraction, and limited X extraction.
- `src/persistence/markdown`: canonical document/recipe parsing, rendering, atomic writes, history, and imports.
- `src/persistence/sqlite/schema.ts`: Drizzle source for relational tables, columns, and indexes.
- `src/persistence/sqlite/item-search.ts`: query-only mapping for the migration-created FTS5 virtual table; it must stay outside the schema scanned by Drizzle Kit.
- `src/persistence/sqlite/shelf-database.ts`: Drizzle/`better-sqlite3` access, migration startup, disposable metadata and FTS5 indexing, and transient delete tokens.
- `drizzle/`: checked-in forward-only migration history, including custom SQL for FTS5.
- `drizzle.config.ts`: Drizzle Kit configuration; keep its schema path restricted to the relational schema file.
- `src/configuration`: resolves the `USHELF_ROOT` data layout.
- `src/index.ts`: the supported package API.

## Non-negotiable invariants

- Markdown is canonical. SQLite must remain fully rebuildable by initializing or rebuilding through `ShelfService`.
- Apply pending Drizzle migrations whenever `ShelfDatabase` opens and before `ShelfService` reconciles Markdown. Do not add inline schema DDL, `SCHEMA_VERSION`, or `PRAGMA user_version` management.
- The Drizzle baseline is the only supported database schema. Do not detect, adopt, migrate, or preserve pre-Drizzle development databases; they must be deleted and rebuilt from Markdown.
- After a successful item mutation, atomically save Markdown and then upsert the returned item into SQLite. Do not create an independent database-only representation of durable state.
- Preserve the marked Insights and Source sections and validated frontmatter when changing the Markdown codec. A parsed item's `revision` is the SHA-256 of its complete Markdown document.
- Archive a completed enrichment before clearing or replacing it because of a changed source, requested re-enrichment, or new insights.
- Honor supplied revisions on mutations. Enrichment writes must also verify the current recipe hash and reject citation URLs absent from the original/canonical URL or captured source.
- Canonical URLs drive web deduplication and original-file hashes drive document deduplication. Keep SQLite item paths portable relative to `library/items` and reject paths that escape that directory.
- Permanent deletion stays a two-step token flow. Consuming a token is single-use and expiry-bound.
- X fallback accepts agent-supplied content only for X items and records `agent_supplied`; never imply it was independently extracted.

## Extraction and security

- Accept only HTTP(S), reject credentials, and check every redirect target before fetching.
- Preserve DNS/private-address blocking, the 15-second timeout, 5 MB response limit, content-type validation, and five-redirect limit unless the product requirements explicitly change.
- Keep deterministic capture separate from agent enrichment. Core must not call a model or require an AI API key.
- Treat attached PDFs as untrusted input. Preserve file-size and page-count limits, reject encrypted or textless PDFs, and keep retained originals beneath `library/files` without exposing filesystem paths.
- Continue sanitizing extracted HTML before Markdown conversion. Preserve absolute source links, localize rendered images into content-addressed item files, and preserve portable fenced code including Mermaid normalization.

## Change guidance

- Define external data with Zod at the domain or parsing boundary and derive TypeScript types where practical.
- Keep ESM imports ending in `.js`.
- For relational schema changes, edit `src/persistence/sqlite/schema.ts`, run `pnpm db:generate --name=descriptive_name`, and review the generated SQL and snapshot before committing them.
- For FTS5 or other SQLite DDL Drizzle Kit cannot model, generate a named custom migration. Keep raw runtime SQL limited to unavoidable dialect operations such as `MATCH`; ordinary CRUD and transactions stay typed through Drizzle.
- Do not rewrite an existing migration incidentally. Baseline consolidation requires an explicit coordinated change and resetting all affected development/test databases.
- `better-sqlite3` is a native production dependency. Keep its pnpm build allowlist and Docker build toolchain intact, and ensure the runtime image includes `packages/core/drizzle/` without including compiler tooling.
- Add new adapter-facing exports to `src/index.ts`; avoid exposing a class solely to make an adapter bypass `ShelfService`.
- When a `ShelfService` method or public schema changes, inspect both adapters, `apps/web/src/api.ts`, recipes, and skills for contract impact.
- Use temporary test roots via `resolveConfig`; tests must not write into the real `library/` or `.ushelf/` directories.

## Verification

Run focused Vitest files while iterating, then the package checks:

```sh
pnpm test -- packages/core/src/path/to/file.test.ts
pnpm db:check
pnpm --filter @ushelf/core typecheck
pnpm --filter @ushelf/core build
```

For database changes, test fresh migration application, repeated startup idempotence, typed query behavior, FTS5 search, and Markdown reconciliation. Do not add legacy-schema fixtures or compatibility tests.

For changes to shared behavior or public contracts, also run root `pnpm test`, `pnpm typecheck`, and `pnpm build`.
