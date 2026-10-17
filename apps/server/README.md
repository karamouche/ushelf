# @ushelf/server

The HTTP and command-line adapter for uShelf. It exposes the library to the web app, hosts the MCP endpoint for agents, serves the production frontend, and provides maintenance commands for the index and Markdown imports.

## What to know

- `src/app.ts` defines a small Hono API for health checks, listing/searching items, reading an item, serving validated local item media, updating reading progress, listing recipes, and targeted Kindle delivery.
- `POST /mcp` hosts the `@ushelf/mcp` tools statelessly over Streamable HTTP. Requests up to 16 MiB are accepted so attached PDFs fit.
- `src/api-auth.ts` authenticates `Authorization: Bearer` requests against `USHELF_API_TOKEN` (at least 32 characters). Token requests skip the browser session and origin checks; an invalid token is always rejected. `/mcp`, `GET /api/server`, `GET /api/agent/skills`, and `PUT`/`DELETE /api/kindle/credential` accept only the token. Without a configured token those routes are unavailable.
- `src/index.ts` initializes `ShelfService` and starts the Node server.
- `src/cli.ts` implements the `rebuild-index` and `import` maintenance commands.
- Business rules, extraction, Markdown persistence, and SQLite indexing belong in `@ushelf/core`, not this package.
- The server binds to `127.0.0.1:43110` by default. Override this with `USHELF_HOST` and `USHELF_PORT`.
- `USHELF_ROOT` selects the directory containing `library/`, `recipes/`, `state/`, and `secrets/`; it defaults to `~/.ushelf`. State and secrets follow the root unless their dedicated override variables are set.
- With `NODE_ENV=production`, the server also serves `apps/web/dist` with an SPA fallback.
- A nonempty `USHELF_APP_PASSWORD` requires browser sign-in for HTTP library routes. Without it, browser access is password-free, which is only appropriate on loopback. Protected production access requires HTTPS because session cookies are Secure.
- Media responses always use `Cache-Control: no-store`. Purge media cached by any existing proxy or CDN before enabling a password on a previously exposed installation; old public cache entries can otherwise bypass the origin's sign-in gate.
- The `dev` command sets `NODE_ENV=development` so password sign-in can use an HTTP cookie on the loopback development servers. Do not expose development servers remotely.

## Commands

Run from the repository root:

```sh
pnpm --filter @ushelf/server dev
pnpm --filter @ushelf/server build
pnpm --filter @ushelf/server start
pnpm rebuild-index
pnpm import -- /absolute/path/to/item.md
```

Build `@ushelf/core` first when running this package outside the root scripts.
