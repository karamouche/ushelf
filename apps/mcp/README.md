# @ushelf/mcp

The Model Context Protocol adapter for uShelf. It lets a connected agent ingest sources, add source-grounded insights, search and manage the library, and read item or recipe resources.

## What to know

- The server communicates over stdio; stdout is reserved for MCP traffic.
- `src/index.ts` registers all tools and resources, then delegates their work to `ShelfService` from `@ushelf/core`.
- Tools cover URL and attached-PDF ingestion, X-thread source fallback, enrichment, listing/search, reading state, source refresh, re-enrichment, and confirmation-gated deletion.
- Resources expose normalized source Markdown, complete item data, and recipe instructions through `ushelf://` URIs.
- Inputs are validated with Zod. Mutating operations use item revisions where appropriate to prevent stale writes.
- `USHELF_ROOT` must point at the uShelf data root when the process is launched from elsewhere. Otherwise it defaults to the current working directory.
- Agent workflow guidance lives separately in `skills/ushelf-ingest` and `skills/ushelf-library`.

## Commands

Installed users should register and launch this adapter through the native CLI:

```sh
ushelf setup codex
ushelf mcp
```

For repository development, run from the repository root:

```sh
pnpm --filter @ushelf/mcp dev
pnpm --filter @ushelf/mcp build
pnpm --filter @ushelf/mcp start
```

For a client configuration example, see the repository-level [README](../../README.md#connect-an-agent). Build `@ushelf/core` before starting the compiled MCP server.
