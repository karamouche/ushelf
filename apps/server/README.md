# @ushelf/server

The HTTP and command-line adapter for uShelf. It exposes the library to the web app, serves the production frontend, and provides maintenance commands for the local index and Markdown imports.

## What to know

- `src/app.ts` defines a small Hono API for health checks, listing/searching items, reading an item, serving validated local item media, updating reading progress, listing recipes, and targeted Kindle delivery.
- `src/index.ts` initializes `ShelfService` and starts the Node server.
- `src/cli.ts` implements the `rebuild-index` and `import` maintenance commands.
- Business rules, extraction, Markdown persistence, and SQLite indexing belong in `@ushelf/core`, not this package.
- The server binds to `127.0.0.1:43110` by default. Override this with `USHELF_HOST` and `USHELF_PORT`.
- `USHELF_ROOT` selects the directory containing `library/`, `recipes/`, and `.ushelf/`; it defaults to the current working directory.
- With `NODE_ENV=production`, the server also serves `apps/web/dist` with an SPA fallback.

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
