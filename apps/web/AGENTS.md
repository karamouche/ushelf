# Web Reader Agent Guide

This guide applies to `apps/web`. Read the repository `AGENTS.md`, root `README.md`, and this package's `README.md` before editing.

## Purpose and boundary

`@ushelf/web` is a React/Vite SPA for browsing and reading. It has no direct filesystem, SQLite, or Core dependency. All reads and mutations go through the HTTP functions in `src/api.ts`.

## Source responsibilities

- `src/App.tsx`: library and reader routes, filters, Markdown/Mermaid rendering, reading-state UX, and scroll-progress persistence.
- `src/api.ts`: the browser-facing HTTP contract and base-path-aware request helpers.
- `src/styles.css`: the complete visual system and responsive behavior.
- `src/main.tsx`: React bootstrapping and `BrowserRouter` basename configuration.
- `base-path.ts` and `vite.config.ts`: normalize `USHELF_WEB_BASE_PATH`, set Vite's base, and proxy the matching development API path.
- `e2e/`: production-reader behavior in desktop and mobile Playwright projects.

## UI and contract rules

- Keep API types in `src/api.ts` aligned with `apps/server` responses and Core's public item shapes. This duplication is intentional: it documents the HTTP boundary.
- Build every API URL from `import.meta.env.BASE_URL`; avoid root-relative links or fetches that break subpath deployments.
- Preserve `BrowserRouter`'s configured basename and verify both `/` and a non-root base path when routing logic changes.
- Send the latest item revision with reading mutations. When a response returns a new item, replace both rendered state and any mutable ref used by scroll/page-exit handlers.
- Keep search/filter state in URL parameters so library views remain navigable and shareable.
- Maintain accessible names, semantic controls, keyboard-scrollable wide tables, visible failure states, and responsive layouts.

## Untrusted content

- Saved Markdown is untrusted. Continue using `rehype-sanitize`; external links open with `noreferrer`, and remote images remain lazy-loaded with `referrerPolicy="no-referrer"`.
- Mermaid must remain lazy-loaded, configured with `securityLevel: "strict"`, and rendered without trusting source HTML. Invalid diagrams must visibly fall back to the original fenced source.
- Do not introduce raw HTML rendering or relax the sanitization schema without explicit security review and regression coverage.

## Testing and verification

- Keep small pure helpers, such as base-path normalization, under Vitest.
- Add Playwright coverage for visible library/reader workflows, routing, accessibility-sensitive behavior, and Markdown rendering. Prefer route interception for focused item fixtures.
- Build before E2E: Playwright starts the compiled production server from `apps/server/dist` and serves `apps/web/dist`.

```sh
pnpm test -- apps/web/base-path.test.ts
pnpm --filter @ushelf/web typecheck
pnpm --filter @ushelf/web build
pnpm build
pnpm test:e2e
```

Use the smallest relevant checks while iterating. Do not hand-edit `dist/`, `dist-types/`, or `*.tsbuildinfo`.
