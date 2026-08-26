# uShelf Agent Guide

Use this file as the starting context for work anywhere in the repository. Read the root `README.md`, then the package README and nearest package `AGENTS.md` before editing. Package guides add local rules; this root guide still applies when they are silent.

## Project in one minute

uShelf is a local, agent-native read-later library for articles and X threads. Deterministic code captures and normalizes sources; a connected agent performs recipe-driven enrichment. Markdown is the canonical record, while SQLite is a disposable search index.

The main flow is:

```text
Agent -> MCP adapter -> Core -> Markdown + SQLite
                              ^
Browser -> HTTP server --------+
```

There is deliberately no model SDK, API key, embeddings store, or autonomous LLM process in this repository. Preserve that boundary unless the task explicitly changes the product architecture.

## Workspace map

- `packages/core`: Domain rules, schemas, extraction, URL safety, Markdown persistence, SQLite indexing, and `ShelfService`. Put shared behavior here.
- `apps/server`: Thin Hono HTTP and CLI adapter around Core. It also serves the built web app in production.
- `apps/mcp`: Thin stdio MCP adapter around Core. It exposes tools and resources to connected agents.
- `apps/cli`: Native Cobra CLI for installation, Docker lifecycle, maintenance, and agent setup.
- `apps/web`: React/Vite library and reader UI. It only communicates through `/api`.
- `recipes`: Versioned Markdown instructions used for agent enrichment.
- `skills`: Canonical source for the agent-facing ingestion and library-management workflows.
- `library/items`: Canonical saved documents, ignored by Git except for `.gitkeep`.
- `library/history`: Archived enrichment revisions, also ignored by Git.
- `.ushelf/ushelf.db`: Rebuildable local index and transient workflow state; never treat it as canonical.

Each workspace package has a local README with its runtime details and commands.

Package-specific agent guidance lives beside each project:

- `packages/core/AGENTS.md`
- `apps/cli/AGENTS.md`
- `apps/server/AGENTS.md`
- `apps/mcp/AGENTS.md`
- `apps/web/AGENTS.md`

## Setup and common commands

Development requirements: Node.js 24 or newer, pnpm 10, and Go 1.24 or newer.

```sh
pnpm install
pnpm dev
```

Development runs the API at `http://127.0.0.1:43110` and Vite at `http://127.0.0.1:43111`.

### Agent setup

Build the MCP server, configure it as described in the root README, and symlink the repository-owned skills into the user skill directory:

```sh
mkdir -p ~/.agents/skills
ln -s /absolute/path/to/ushelf/skills/ushelf-ingest ~/.agents/skills/ushelf-ingest
ln -s /absolute/path/to/ushelf/skills/ushelf-library ~/.agents/skills/ushelf-library
```

Do not copy these folders: `skills/` must remain the single source of truth so repository updates are reflected through the links. Restart the agent if the skills do not appear immediately.

Use these repository-level checks:

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
pnpm format:check
pnpm validate:skills
go -C apps/cli vet ./...
```

Run the smallest relevant checks while iterating, then run `pnpm typecheck`, `pnpm test`, and `pnpm build` before handing off a cross-package change. Build before `pnpm test:e2e`; Playwright launches the compiled production server.

## Engineering rules

- Keep adapters thin. Do not duplicate business rules between HTTP, MCP, and Web.
- Use `ShelfService` as the application boundary. Apps should not coordinate `MarkdownRepository` and `ShelfDatabase` directly.
- Preserve Markdown as the source of truth. Any index change must remain rebuildable with `pnpm rebuild-index`.
- Do not manually edit files under `library/` while the app is running. Use Core, MCP tools, or the import CLI for mutations.
- Preserve atomic Markdown writes, archived enrichment history, optimistic revision checks, recipe-hash checks, and citation validation.
- Preserve URL protections when changing extraction: allow only HTTP(S), reject credentials and private-network targets, and retain response-size, timeout, and redirect limits.
- Keep deterministic extraction separate from LLM enrichment. Avoid introducing token-consuming work into capture, search, or reading-state updates.
- Treat X fallback content as agent-supplied, not independently verified.
- Use strict TypeScript and keep `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` clean.
- This repository uses ESM. Local TypeScript imports use `.js` extensions so emitted Node imports resolve correctly.
- Validate external input at adapter or parsing boundaries with the existing Zod schemas.
- When the HTTP response contract changes, update the matching client types in `apps/web/src/api.ts`.
- Add focused regression tests beside the affected source as `*.test.ts`. Add or update Playwright coverage for user-visible reader workflows.
- Do not add production dependencies unless the task requires them; prefer existing platform and workspace capabilities.
- Treat `dist/`, `dist-types/`, `*.tsbuildinfo`, `.ushelf/`, Playwright output, and installed `node_modules/` as generated or local state. Change source files and let the relevant command regenerate outputs; do not include generated artifacts in a patch.

## Where to make a change

- Ingestion, extraction, storage, search, recipes, concurrency, or validation: `packages/core` first.
- Browser-facing API contract or maintenance CLI: `apps/server`.
- Agent tool/resource contract: `apps/mcp`, plus the relevant skill when workflow guidance changes.
- Installation, Docker orchestration, updates, or agent-client setup: `apps/cli`.
- Reader behavior or presentation: `apps/web`; keep persistence behind the API.
- Agent enrichment behavior: `recipes` for output instructions, `skills` for tool-use workflow.

When changing shared behavior, inspect both adapters and the web client for contract impact.

## Storage and workflow invariants

- Item Markdown contains validated frontmatter plus separate insight and source sections.
- Canonical URLs provide ingestion deduplication.
- Content hashes detect source changes; recipe hashes detect stale enrichment.
- A changed enriched source is archived before its insights are cleared.
- SQLite startup reconciliation must restore index state from Markdown.
- Permanent deletion remains a two-step, short-lived confirmation-token flow.
- Reading updates may include the current item revision and must reject stale writes.

## Agent workflow changes

The skills under `skills/ushelf-ingest` and `skills/ushelf-library` are part of the product contract. If an MCP tool name, input, output, or required sequence changes, update the affected skill and run `pnpm validate:skills`.

Keep summaries compact and source-grounded. Do not manufacture missing source text or citations. Avoid re-enriching an already-ready duplicate unless the user explicitly requests it; this prevents unnecessary token use.

## Before handing off

- Review the diff for unrelated or generated files.
- Confirm package boundaries and storage invariants still hold.
- Run relevant tests and report exactly what ran.
- Mention any check that could not run and why.
- Update the relevant README when setup, architecture, commands, or public behavior changes.
