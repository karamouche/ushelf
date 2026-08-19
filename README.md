# uShelf

A local, agent-native shelf for blog posts and X threads you want to read later. uShelf stores completed items as readable Markdown, uses SQLite only as a rebuildable search/index layer, and delegates all AI reasoning to your connected agent through MCP.

## What is included

- Deterministic article extraction with Readability, sanitization, URL safety checks, and an agent-supplied fallback for X.
- Versioned Markdown recipes and typed, cited insight capture.
- Full library CRUD over MCP, optimistic concurrency, resumable ingestion, stale-recipe detection, and confirmation-gated deletion.
- SQLite FTS5 search over titles, sources, insights, and tags.
- A responsive, monochrome reader with reading states and scroll restoration.
- Two agent skills in `skills/ushelf-ingest` and `skills/ushelf-library`.

uShelf has no model SDK, AI key, embeddings, or autonomous model process.

## Requirements

- Node.js 24 or newer
- pnpm 10

## Start locally

```sh
pnpm install
pnpm dev
```

The API listens on `http://127.0.0.1:43110`; Vite opens the reader on `http://127.0.0.1:43111`. For a production build:

```sh
pnpm build
NODE_ENV=production pnpm start
```

The production reader is served from `http://127.0.0.1:43110`.

## Connect an agent

Build once, then add a stdio MCP server using the absolute project path:

```json
{
  "mcpServers": {
    "ushelf": {
      "command": "node",
      "args": ["/absolute/path/to/ushelf/apps/mcp/dist/index.js"],
      "env": { "USHELF_ROOT": "/absolute/path/to/ushelf" }
    }
  }
}
```

Symlink the repository-owned skills into your user skill directory so they stay available from any workspace and automatically reflect repository updates:

```sh
mkdir -p ~/.agents/skills
ln -s /absolute/path/to/ushelf/skills/ushelf-ingest ~/.agents/skills/ushelf-ingest
ln -s /absolute/path/to/ushelf/skills/ushelf-library ~/.agents/skills/ushelf-library
```

Restart the agent if the skills do not appear immediately. Then ask it to “save this URL to uShelf” or “search my uShelf for writing about local-first software.”

## Storage contract

- `library/items/`: canonical current Markdown documents.
- `library/history/`: prior enrichment revisions.
- `recipes/`: editable, hash-versioned agent instructions.
- `.ushelf/ushelf.db`: disposable index and short-lived workflow data.

The app owns files under `library/` while running. To recover the index, run `pnpm rebuild-index`. To bring in an externally edited compatible item, stop the app and run `pnpm import -- /absolute/path/item.md`.

Remote article images are not downloaded. Rendering uses sanitized Markdown, lazy image loading, and a no-referrer policy.

## Quality checks

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm validate:skills
```
