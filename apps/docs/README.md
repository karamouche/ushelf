# @ushelf/docs

The uShelf documentation site, built with [Starlight](https://starlight.astro.build/) and published to <https://karamouche.github.io/ushelf/>.

## What to know

- Pages are Markdown or MDX under `src/content/docs/`; the sidebar is declared in `astro.config.mjs`.
- Link between pages with relative links such as `../../deploy/overview/`, so the site works under any base path.
- Shared images live in `src/assets/`; the root README references the same files.
- The site deploys under `/ushelf` by default. Set `DOCS_SITE` and `DOCS_BASE` to build for another host.

## Commands

Run from the repository root:

```sh
pnpm docs:dev
pnpm docs:build
```
