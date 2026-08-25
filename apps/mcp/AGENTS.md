# MCP Adapter Agent Guide

This guide applies to `apps/mcp`. Read the repository `AGENTS.md`, root `README.md`, and this package's `README.md` before editing.

## Purpose and boundary

This package is a thin local stdio MCP adapter over `ShelfService`. It translates MCP tools and resources into Core calls; it does not own ingestion policy, persistence, domain transitions, or enrichment logic.

The connected agent performs recipe-driven reasoning. Do not add a model SDK, model API key, autonomous background loop, or hidden enrichment call here.

## Transport rules

- `stdout` is exclusively MCP protocol traffic. Send diagnostics to `stderr` and never add ordinary `console.log` calls.
- Initialize `ShelfService` before accepting requests and allow `USHELF_ROOT` to select the data root.
- Keep tools focused and composable. Validate every tool input with Zod before it crosses into Core.
- Return machine-readable `structuredContent` and equivalent text content through the shared JSON response shape unless a tool genuinely needs another MCP content type.
- MCP resources are read-only views. Use tools, not resources, for mutations.
- Tool and resource handlers should delegate directly to one `ShelfService` operation or a simple read-only projection. Move reusable decisions into Core.

## Contract changes

- Tool names, input schemas, response shapes, descriptions, resource URIs, and required call sequences are public agent contracts.
- If a Core schema already expresses an input enum or object, reuse its exported schema instead of duplicating accepted values.
- When changing ingestion or library-management workflows, update the relevant file under `skills/` and run `pnpm validate:skills`.
- Keep destructive behavior obvious in tool names and descriptions. Permanent deletion must continue to require `request_delete` followed by `confirm_delete` with the short-lived token.
- Preserve recipe hash, item revision, and source-grounding fields in the ingestion context/save flow.
- Update `apps/mcp/README.md` and the root setup example for user-visible configuration or protocol changes.

## Testing and verification

There are currently no MCP-specific tests. Add focused tests when introducing handler logic or a regression-prone contract; keep most behavioral coverage in Core.

```sh
pnpm --filter @ushelf/core build
pnpm --filter @ushelf/mcp build
pnpm validate:skills
```

For cross-package changes, also run root `pnpm typecheck`, `pnpm test`, and `pnpm build`. Do not hand-edit `dist/`.
