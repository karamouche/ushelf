# @ushelf/web

The browser UI for browsing and reading a uShelf library. It provides search and filters, renders saved Markdown, and keeps reading status and scroll progress in sync with the HTTP API.

## What to know

- This is a React 19 single-page app built with Vite.
- `src/App.tsx` contains the library and reader routes; `src/api.ts` is the API client.
- The app does not read library files directly. All data and updates go through the API path below the configured `USHELF_WEB_BASE_PATH`.
- Reader pages can send source-only EPUB editions to a Kindle device after credentials are configured through the native CLI, and default to the last successfully used device when it remains registered.
- Rendered Markdown is sanitized. Only content-addressed item media is rendered; external or malformed image references are shown as omission text and never requested.
- Fenced `mermaid` blocks render locally in strict mode. Invalid diagrams fall back to their original source code.
- In development, Vite runs on `127.0.0.1:43111` and proxies the configured base path's `/api` and `/auth` endpoints to the server on port `43110`.
- In production, the server serves the generated `dist/` directory and handles SPA fallback.
- When `USHELF_APP_PASSWORD` is set, the server gates the reader and API behind a password form. The browser uses a server-side session and offers Sign out; expired sessions return to the sign-in page.
- Production assets are path-relative; the server injects the runtime `USHELF_WEB_BASE_PATH` into the HTML shell so one release image supports root and subpath deployments.
- The API response types in `src/api.ts` intentionally describe the client boundary; update them when the server contract changes.

## Commands

Run from the repository root:

```sh
cp .env.example .env
pnpm --filter @ushelf/web dev
pnpm --filter @ushelf/web build
pnpm --filter @ushelf/web typecheck
pnpm test:e2e
```

The development UI expects `@ushelf/server` to be running. `pnpm dev` at the repository root starts both.
The root E2E command includes live URL ingestion coverage in addition to browser tests and therefore requires internet access.
