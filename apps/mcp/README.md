# @ushelf/mcp

The Model Context Protocol tool surface for uShelf. It lets a connected agent ingest sources, add a source-grounded description and tags, search and manage the library, send saved items to Kindle, and read item or recipe resources.

## What to know

- This package is a library. `createMcpServer(service, version)` in `src/mcp-server.ts` registers all tools and resources over an initialized `ShelfService` from `@ushelf/core`.
- `@ushelf/server` hosts it statelessly at `POST <base path>/mcp` using Streamable HTTP, in the same process as the API, so one process owns Markdown and SQLite. The endpoint requires `Authorization: Bearer $USHELF_API_TOKEN`, or a connector access token that the server issued through OAuth.
- Agents reach it through `ushelf mcp`, the CLI's stdio bridge, which adds the context's token. Clients that speak Streamable HTTP natively can also connect to the endpoint directly with the bearer header. Hosted apps such as Claude (web, desktop, mobile) and ChatGPT connect as OAuth connectors; the server owns that flow, and this package is unaware of how a request was authenticated.
- Tools cover URL and attached-PDF ingestion, X-thread source fallback, enrichment, listing/search, reading state, Kindle device discovery and delivery, source refresh, re-enrichment, and confirmation-gated deletion. Images in captured and agent-supplied Markdown are localized by Core before the item is saved.
- Resources expose normalized source Markdown, complete item data, and recipe instructions through `ushelf://` URIs.
- Inputs are validated with Zod. Mutating operations use item revisions where appropriate to prevent stale writes.
- Agent workflow guidance lives separately in `skills/ushelf-ingest` and `skills/ushelf-library`; the server publishes them to `ushelf setup`.

## Kindle delivery

Run `ushelf kindle setup` before asking an agent to send a saved item. The agent uses `list_kindle_devices` to resolve a registered destination and `send_to_kindle` with the saved item ID and selected device serial. Delivery produces a source-only EPUB with validated local images; the generated description is excluded. MCP tools never return the credential. The integration uses Amazon's unofficial, undocumented Send to Kindle protocol and may stop working if Amazon changes it.

## Development

```sh
pnpm --filter @ushelf/core build
pnpm --filter @ushelf/mcp build
```

To use it from an agent during development, run `pnpm dev` with `USHELF_API_TOKEN` set in `.env`, register the dev server with `ushelf context add dev --url http://127.0.0.1:43110`, and run `ushelf setup claude`.
