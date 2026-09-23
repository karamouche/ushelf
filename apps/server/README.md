# @ushelf/server

The HTTP and command-line adapter for uShelf. It exposes the library to the web app, serves the production frontend, and provides maintenance commands for the local index and Markdown imports.

## What to know

- `src/app.ts` defines the reader API and single-owner remote routes. `src/auth.ts` owns durable Better Auth state under `<USHELF_ROOT>/auth/`; `src/mcp-http.ts` exposes OAuth-protected Streamable HTTP; `src/remote-maintenance.ts` handles authenticated CLI operations.
- `src/index.ts` initializes `ShelfService` and starts the Node server.
- `src/cli.ts` implements the `rebuild-index` and `import` maintenance commands.
- Business rules, extraction, Markdown persistence, and SQLite indexing belong in `@ushelf/core`, not this package.
- The server binds to `127.0.0.1:43110` by default. Override this with `USHELF_HOST` and `USHELF_PORT`. Remote mode requires `USHELF_MODE=remote` and a stable HTTPS origin in `USHELF_PUBLIC_URL`; it must be mounted at the origin root behind TLS termination.
- `USHELF_ROOT` selects the directory containing `library/`, `recipes/`, `state/`, and `secrets/`; it defaults to `~/.ushelf`. State and secrets follow the root unless their dedicated override variables are set.
- With `NODE_ENV=production`, the server also serves `apps/web/dist` with an SPA fallback.

## Commands

Run from the repository root:

```sh
pnpm --filter @ushelf/server dev
pnpm --filter @ushelf/server build
pnpm --filter @ushelf/server start
pnpm rebuild-index
pnpm import -- /absolute/path/to/item.md
USHELF_MODE=remote USHELF_PUBLIC_URL=https://your-shelf.example node apps/server/dist/cli.js reset-password
```

Build `@ushelf/core` first when running this package outside the root scripts.
