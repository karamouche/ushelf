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

## Run continuously with Docker Compose

The Compose deployment builds the production reader and API into one container, restarts it after
failures or host reboots, and keeps the canonical Markdown and rebuildable SQLite index on the host.

Prepare the writable bind-mount directories, then start the service:

```sh
mkdir -p library/items library/history .ushelf
docker compose up -d --build
docker compose ps
```

The container runs as the unprivileged `node` user (UID/GID `1000:1000`). On a VPS where those
directories are not writable by UID 1000, fix their ownership before starting:

```sh
sudo chown -R 1000:1000 library .ushelf
```

The reader is available at `http://127.0.0.1:43110` on the VPS. It is deliberately not published on
all network interfaces because uShelf does not provide HTTP authentication. Put an authenticated
HTTPS reverse proxy such as Caddy, Nginx, or Cloudflare Access in front of it, or reach it through a
VPN or SSH tunnel. Do not expose port 43110 directly to the public internet.

Common operations:

```sh
docker compose logs -f ushelf
docker compose restart ushelf
docker compose down

git pull
docker compose up -d --build
```

To rebuild the disposable SQLite index, stop the server so it is not modifying the library, run the
compiled maintenance command against the same bind mounts, and start it again:

```sh
docker compose stop ushelf
docker compose run --rm --no-deps ushelf node apps/server/dist/cli.js rebuild-index
docker compose up -d
```

For a consistent backup, stop the service and back up `library/` and `recipes/`, then start it again.
The `.ushelf/` directory does not need to be backed up because it can be rebuilt from Markdown.

The stdio MCP adapter is not a long-running Compose service. An agent running on the VPS can use the
normal MCP configuration below and point `USHELF_ROOT` at this repository; the bind mounts ensure the
server and host-side MCP process share the same canonical files.

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
