# Docs Agent Guide

This guide applies to `apps/docs`. Read the repository `AGENTS.md` and this package's `README.md` before editing.

## Purpose and boundary

This package is the user-facing documentation site. It describes behavior implemented elsewhere; it contains no product code. When behavior changes in another package, update the matching page here in the same change.

## Writing rules

- Document only what the code does today. Mark unsupported or planned behavior explicitly rather than describing it as available.
- Take commands, flags, routes, and tool names from the source or `--help` output, not from memory.
- Keep pages task-oriented, and keep reference tables complete: `reference/cli.md`, `reference/configuration.md`, `reference/mcp.md`, and `reference/http-api.md`.
- Use relative links between pages and add every new page to the sidebar in `astro.config.mjs`.
- Keep the root README short; link here for details instead of duplicating them.

## Verification

```sh
pnpm docs:build
pnpm format:check
```
