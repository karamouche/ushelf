# @ushelf/core

The domain and storage layer shared by uShelf's HTTP and MCP adapters. It owns source extraction, item workflows, Markdown files, recipes, validation, and the rebuildable SQLite search index.

## What to know

- `ShelfService` is the main entry point. Apps should call it instead of coordinating repositories and the database themselves.
- Markdown under `library/items/` is canonical. Original PDFs live under `library/files/`; `.ushelf/ushelf.db` is a disposable SQLite/FTS5 index reconciled from Markdown during initialization.
- SQLite stores item locations relative to `library/items` so host-side agents and the Docker server can safely share the same index across different mount paths. Drizzle applies checked-in schema migrations before the index is reconciled from Markdown during initialization.
- Previous enriched revisions are archived under `library/history/`; recipe Markdown under `recipes/` is hash-versioned.
- `MarkdownRepository` validates and atomically writes item documents. `ShelfDatabase` indexes summaries and searchable text.
- Source ingestion uses Readability for articles, layout-aware PDF.js extraction for attached PDF documents, and a limited public extraction path for X. PDF text becomes page-scoped Markdown with joined paragraphs and conservative heading, list, and simple-table recovery. X sources can fall back to agent-supplied Markdown through `ShelfService`.
- Article, X, PDF, and insight images are validated, stored content-addressably beneath `library/files/<item-id>/media/`, and referenced through relative Markdown paths. PDF raster figures are placed according to page coordinates.
- Common Mermaid HTML forms are normalized to fenced `mermaid` Markdown so diagram source remains portable and canonical.
- URL fetching rejects non-HTTP protocols, credentials, private-network targets, oversized responses, and excessive redirects.
- Item `revision` values provide optimistic concurrency. Enrichment also verifies the recipe hash and that citation URLs occur in the captured source.
- Kindle delivery builds a source-only EPUB with validated local media, then delegates device discovery and upload to the bundled Go bridge. Credentials remain outside Markdown and SQLite.
- `USHELF_ROOT` controls the data root and defaults to `process.cwd()`.
- `USHELF_STATE_DIR` optionally places disposable SQLite state outside that root; the native CLI uses it for `~/.ushelf/state`.
- The package uses Drizzle ORM with `better-sqlite3`; Node.js 24+ remains the repository runtime requirement.

## Source layout

Core is organized by responsibility:

```text
src/
  application/    ShelfService workflows
  configuration/  Data-root and path configuration
  domain/         Validated library models and state rules
  ingestion/      URL handling, safe fetching, and source extractors
  persistence/    Markdown storage and the rebuildable SQLite index
```

## Public API

Import from `@ushelf/core`, not internal file paths. The package root exports `ShelfService`, configuration, adapter-facing schemas, and public domain/result types. Extraction helpers, Markdown codecs, repositories, and SQLite implementation classes are internal details.

## Commands

Run from the repository root:

```sh
pnpm --filter @ushelf/core build
pnpm --filter @ushelf/core typecheck
pnpm test
```

## SQLite schema workflow

The readable schema source is `src/persistence/sqlite/schema.ts`. Drizzle Kit generates the
checked-in SQL history under `drizzle/`, and Core applies pending migrations whenever it opens
the database.

After changing a relational table or index, generate and review a named migration:

```sh
pnpm db:generate --name=describe_the_change
pnpm db:check
```

FTS5 virtual tables are not part of the Drizzle schema. Create those changes as custom SQL
migrations and keep their query-only mappings outside `schema.ts`:

```sh
pnpm --dir packages/core exec drizzle-kit generate --config=drizzle.config.ts --custom --name=describe_the_fts_change
```

The Drizzle baseline replaces the earlier inline schema outright. Pre-Drizzle development
databases are unsupported: delete the disposable SQLite database before starting this version,
then initialize or run `pnpm rebuild-index` to restore the index from canonical Markdown.

Unit tests for core behavior live alongside the source as `*.test.ts` files.
