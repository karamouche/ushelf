# @ushelf/web

The browser UI for browsing and reading a uShelf library. It provides search and filters, renders saved Markdown, and keeps reading status and scroll progress in sync with the HTTP API.

## What to know

- This is a React 19 single-page app built with Vite.
- `src/App.tsx` contains the library and reader routes; `src/api.ts` is the API client.
- The app does not read library files directly. All data and updates go through `/api`.
- Rendered Markdown is sanitized. Remote images are lazy-loaded with a no-referrer policy.
- In development, Vite runs on `127.0.0.1:43111` and proxies `/api` to the server on port `43110`.
- In production, the server serves the generated `dist/` directory and handles SPA fallback.
- The API response types in `src/api.ts` intentionally describe the client boundary; update them when the server contract changes.

## Commands

Run from the repository root:

```sh
pnpm --filter @ushelf/web dev
pnpm --filter @ushelf/web build
pnpm --filter @ushelf/web typecheck
pnpm test:e2e
```

The development UI expects `@ushelf/server` to be running. `pnpm dev` at the repository root starts both.
