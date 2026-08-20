# @ushelf/core

The domain and storage layer shared by uShelf's HTTP and MCP adapters. It owns source extraction, item workflows, Markdown files, recipes, validation, and the rebuildable SQLite search index.

## What to know

- `ShelfService` is the main entry point. Apps should call it instead of coordinating repositories and the database themselves.
- Markdown under `library/items/` is canonical. `.ushelf/ushelf.db` is a disposable SQLite/FTS5 index reconciled from those files during initialization.
- SQLite stores item locations relative to `library/items` so host-side agents and the Docker server can safely share the same index across different mount paths.
- Previous enriched revisions are archived under `library/history/`; recipe Markdown under `recipes/` is hash-versioned.
- `MarkdownRepository` validates and atomically writes item documents. `ShelfDatabase` indexes summaries and searchable text.
- `extractUrl` uses Readability for articles and a limited public extraction path for X. X threads can fall back to agent-supplied Markdown through `ShelfService`.
- URL fetching rejects non-HTTP protocols, credentials, private-network targets, oversized responses, and excessive redirects.
- Item `revision` values provide optimistic concurrency. Enrichment also verifies the recipe hash and that citation URLs occur in the captured source.
- `USHELF_ROOT` controls the data root and defaults to `process.cwd()`.
- The package uses Node's built-in SQLite API and therefore follows the repository's Node.js 24+ requirement.

## Public modules

`src/index.ts` exports configuration, types and schemas, URL handling, extraction, Markdown serialization, repository and database classes, and `ShelfService`.

## Commands

Run from the repository root:

```sh
pnpm --filter @ushelf/core build
pnpm --filter @ushelf/core typecheck
pnpm test
```

Unit tests for core behavior live alongside the source as `*.test.ts` files.
