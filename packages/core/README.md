# @ushelf/core

The domain and storage layer shared by uShelf's HTTP and MCP adapters. It owns source extraction, item workflows, Markdown files, recipes, validation, and the rebuildable SQLite search index.

## What to know

- `ShelfService` is the main entry point. Apps should call it instead of coordinating repositories and the database themselves.
- Markdown under `library/items/` is canonical. Original PDFs live under `library/files/`; `.ushelf/ushelf.db` is a disposable SQLite/FTS5 index reconciled from Markdown during initialization.
- SQLite stores item locations relative to `library/items` so host-side agents and the Docker server can safely share the same index across different mount paths.
- Previous enriched revisions are archived under `library/history/`; recipe Markdown under `recipes/` is hash-versioned.
- `MarkdownRepository` validates and atomically writes item documents. `ShelfDatabase` indexes summaries and searchable text.
- Source ingestion uses Readability for articles, PDF.js for attached PDF documents, and a limited public extraction path for X. X sources can fall back to agent-supplied Markdown through `ShelfService`.
- Article, X, PDF, and insight images are validated, stored content-addressably beneath `library/files/<item-id>/media/`, and referenced through relative Markdown paths. PDF raster figures are placed according to page coordinates.
- Common Mermaid HTML forms are normalized to fenced `mermaid` Markdown so diagram source remains portable and canonical.
- URL fetching rejects non-HTTP protocols, credentials, private-network targets, oversized responses, and excessive redirects.
- Item `revision` values provide optimistic concurrency. Enrichment also verifies the recipe hash and that citation URLs occur in the captured source.
- `USHELF_ROOT` controls the data root and defaults to `process.cwd()`.
- `USHELF_STATE_DIR` optionally places disposable SQLite state outside that root; the native CLI uses it for `~/.ushelf/state`.
- The package uses Node's built-in SQLite API and therefore follows the repository's Node.js 24+ requirement.

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

Unit tests for core behavior live alongside the source as `*.test.ts` files.
