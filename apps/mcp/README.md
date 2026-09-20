# @ushelf/mcp

The Model Context Protocol adapter for uShelf. It lets a connected agent ingest sources, add source-grounded insights, search and manage the library, send saved items to Kindle, and read item or recipe resources.

## What to know

- The server communicates over stdio; stdout is reserved for MCP traffic.
- `src/index.ts` registers all tools and resources, then delegates their work to `ShelfService` from `@ushelf/core`.
- Tools cover URL and attached-PDF ingestion, X-thread source fallback, enrichment, listing/search, reading state, Kindle device discovery and delivery, source refresh, re-enrichment, and confirmation-gated deletion. Images in captured and agent-supplied Markdown are localized by Core before the item is saved.
- Resources expose normalized source Markdown, complete item data, and recipe instructions through `ushelf://` URIs.
- Inputs are validated with Zod. Mutating operations use item revisions where appropriate to prevent stale writes.
- `USHELF_ROOT` must point at the uShelf data root when the process is launched from elsewhere. Otherwise it defaults to the current working directory.
- Agent workflow guidance lives separately in `skills/ushelf-ingest` and `skills/ushelf-library`.

## Kindle delivery

Run `ushelf kindle setup` before asking an agent to send a saved item. The agent uses `list_kindle_devices` to resolve a registered destination and `send_to_kindle` with the saved item ID and selected device serial. Delivery produces a source-only EPUB with validated local images; generated insights are excluded.

The native CLI mounts the Kindle credential read-only into the MCP container. MCP tools never return its contents. The integration uses Amazon's unofficial, undocumented Send to Kindle protocol and may stop working if Amazon changes it.

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
