# Server Adapter Agent Guide

This guide applies to `apps/server`. Read the repository `AGENTS.md`, root `README.md`, and this package's `README.md` before editing.

## Purpose and boundary

`@ushelf/server` is the thin Hono HTTP and maintenance-CLI adapter around `ShelfService`. It owns HTTP parsing/serialization, process startup, production static hosting, and CLI argument handling. Domain rules, storage coordination, extraction, validation semantics, and index behavior belong in Core.

## Source responsibilities

- `src/app.ts`: construct the injectable Hono app, API routes, adapter validation, CORS, error responses, configured base path, and production SPA/static routing.
- `src/index.ts`: initialize `ShelfService`, resolve runtime host/port/base-path settings, locate the built web app, and start Node's HTTP server.
- `src/cli.ts`: thin `rebuild-index` and validated Markdown `import` commands.

Keep `createApp` testable with an injected service. Avoid module-level server startup in `app.ts`.

## HTTP contract rules

- All browser data access remains under `/api`, prefixed by normalized `USHELF_WEB_BASE_PATH` when configured.
- Validate query and body values at the HTTP boundary, preferably with schemas exported by Core. Pass complete use cases to `ShelfService` rather than coordinating persistence here.
- Keep response envelopes stable (`{ items }`, `{ item }`, `{ recipes }`, `{ error }`). If a response field or accepted value changes, update `apps/web/src/api.ts` and affected web behavior/tests in the same change.
- Reading-state writes should forward the client's revision so stale updates can be rejected.
- Preserve the development CORS allowlist unless development origins intentionally change. uShelf provides no HTTP authentication, so retain the loopback host default and do not document direct public exposure.
- Production hosting must serve built assets and fall back to `index.html` only within the configured base path. API errors must not be converted into SPA responses.

## CLI and data safety

- CLI commands initialize Core and use `ShelfService`; they must not edit Markdown or SQLite directly.
- `rebuild-index` treats Markdown as canonical. `import` validates the document and rejects canonical-URL duplicates.
- Do not run mutation-oriented CLI tests against the repository's real data root. Use a temporary `USHELF_ROOT`.

## Testing and verification

Add route regressions beside `src/app.ts` as `*.test.ts`. Exercise `createApp().request(...)` for adapter behavior; test shared workflow semantics in Core.

```sh
pnpm test -- apps/server/src/app.test.ts
pnpm --filter @ushelf/core build
pnpm --filter @ushelf/server build
```

If the HTTP contract affects the reader, also run the web typecheck/build and the relevant Playwright tests. Do not hand-edit `dist/`, local `state/`, or local `secrets/` files.
