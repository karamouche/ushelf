<p align="center">
  <img src="docs/assets/ushelf-hero.svg" alt="uShelf - a quiet place for unfinished reading" width="100%" />
</p>

<p align="center">
  <strong>A local, agent-native library for the writing worth keeping.</strong><br />
  Capture deterministically. Enrich with your agent. Keep everything as readable Markdown.
</p>

<p align="center">
  <img alt="Node.js 24+" src="https://img.shields.io/badge/Node.js-24%2B-111111?style=flat-square" />
  <img alt="pnpm 10" src="https://img.shields.io/badge/pnpm-10-111111?style=flat-square" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-111111?style=flat-square" />
  <img alt="Model Context Protocol" src="https://img.shields.io/badge/MCP-native-111111?style=flat-square" />
  <img alt="Local first" src="https://img.shields.io/badge/storage-local--first-111111?style=flat-square" />
</p>

## Why uShelf?

Most read-later tools own the database and bolt AI onto the side. uShelf takes the opposite approach:

- **Your files are the product.** Every completed item lives as portable, readable Markdown.
- **Your agent does the thinking.** uShelf exposes an MCP server and recipe-driven workflows, not a bundled model.
- **Capture stays deterministic.** Web sources are extracted, sanitized, normalized, and checked before enrichment begins.
- **The index is disposable.** SQLite FTS5 makes the library fast to search and can always be rebuilt from Markdown.
- **Reading is first-class.** The web reader tracks inbox, reading, read, and archived states, plus scroll progress.

> uShelf includes no model SDK, AI API key, embeddings store, or autonomous LLM process.

## How it works

<p align="center">
  <img src="docs/assets/ushelf-workflow.svg" alt="uShelf architecture: agents and browsers use thin adapters around ShelfService, with Markdown as the canonical record and SQLite as a rebuildable index" width="100%" />
</p>

1. Ask your connected agent to save something from the web.
2. uShelf captures and normalizes the source with deterministic code.
3. The agent follows a versioned recipe to add cited summaries, insights, and tags.
4. You search and read everything in the web app, while the canonical record stays in Markdown.

## Quick start

Install the native CLI on macOS or Linux. Docker must already be installed and running.

```sh
curl -fsSL https://github.com/karamouche/ushelf/releases/latest/download/install.sh | sh
ushelf doctor
ushelf start
```

Open the reader at [http://127.0.0.1:43110](http://127.0.0.1:43110), or run `ushelf open`. Your library, recipes, configuration, and disposable index live under `~/.ushelf`.

Useful lifecycle commands:

```sh
ushelf status
ushelf logs --follow
ushelf stop
ushelf update
```

The CLI downloads a release-matched container image. Node.js, pnpm, a repository clone, and Docker Compose are not required for normal use.

The installer places the executable at `~/.local/bin/ushelf`. uShelf automatically creates its configuration, library, recipes, state, and versioned agent assets under `~/.ushelf` when needed.

The installer supports macOS and Linux on amd64 and arm64; Windows users can run it under WSL.

### CLI reference

| Command                | Purpose                                                         |
| ---------------------- | --------------------------------------------------------------- |
| `ushelf start`         | Initialize local files and start or reconcile the reader/API    |
| `ushelf stop`          | Remove the managed container without deleting data              |
| `ushelf status`        | Show health, URL, version, image, and home                      |
| `ushelf logs`          | Read or follow managed service logs                             |
| `ushelf open`          | Open the reader in the system browser                           |
| `ushelf mcp`           | Run the foreground stdio MCP container                          |
| `ushelf setup CLIENT`  | Configure Codex, Claude Code, or both and link bundled skills   |
| `ushelf doctor`        | Check Docker, filesystem, port, image, recipe, and client setup |
| `ushelf update`        | Verify and install the latest CLI and matching image            |
| `ushelf rebuild-index` | Rebuild disposable SQLite state from Markdown                   |
| `ushelf import FILE`   | Import a compatible Markdown item                               |
| `ushelf config show    | path                                                            | ...` | Inspect or update persistent configuration |
| `ushelf version`       | Show CLI build and runtime image information                    |

## Connect your agent

Configure Codex, Claude Code, or both. This registers `ushelf mcp` at user scope and links the bundled workflows into the client's personal skill directory.

```sh
ushelf setup codex
ushelf setup claude
# or: ushelf setup all
```

Use `ushelf setup <client> --print` to inspect the exact registration command without making changes. Then try:

```text
Save this URL to uShelf.
Search my uShelf for writing about local-first software.
Show me unread pieces tagged architecture.
```

## What is included

| Layer            | What it does                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| **CLI**          | Native installation, Docker lifecycle, updates, maintenance, and agent-client setup                                 |
| **Core**         | URL safety, extraction, schemas, recipes, Markdown persistence, SQLite indexing, and all domain rules               |
| **MCP**          | Ingestion, enrichment, search, reading state, refresh, re-enrichment, and confirmation-gated deletion tools         |
| **HTTP server**  | A thin Hono API, production web hosting, index rebuilding, and Markdown import commands                             |
| **Web reader**   | A responsive React library and reader with full-text search, filters, reading progress, and local Mermaid rendering |
| **Agent skills** | Guided ingestion and library-management workflows that stay in sync with the MCP contract                           |

Extraction includes Readability, sanitization, response and redirect limits, and private-network protections. X threads use a limited public extraction path with an explicitly agent-supplied fallback.

<p align="center">
  <img src="docs/assets/ushelf-principles.svg" alt="The uShelf promise: own the source, bring the agent, and return to the ideas" width="100%" />
</p>

## Data you can understand

```text
~/.ushelf/library/items/    Canonical current Markdown documents
~/.ushelf/library/history/  Archived enrichment revisions
~/.ushelf/recipes/          Editable, hash-versioned agent instructions
~/.ushelf/state/ushelf.db   Rebuildable search index and transient workflow state
```

Markdown remains the source of truth. Canonical URLs deduplicate ingestion, content hashes detect source changes, recipe hashes identify stale enrichment, and revisions protect concurrent updates. If the index disappears, restore it with:

```sh
ushelf rebuild-index
```

To import an externally edited compatible item, run:

```sh
ushelf import /absolute/path/to/item.md
```

Remote source images are not downloaded. The reader renders sanitized Markdown, loads images lazily, and sends no referrer.

## Run continuously with Docker Compose

The Compose setup builds the API and reader into one container, restarts after failures or reboots, and keeps canonical data on the host.

```sh
cp .env.example .env
mkdir -p library/items library/history .ushelf
docker compose up -d --build
docker compose ps
```

The service binds to `127.0.0.1:43110` by default because uShelf does **not** provide HTTP authentication. For remote access, place an authenticated HTTPS proxy such as Caddy, Nginx, or Cloudflare Access in front of it, or use a VPN or SSH tunnel. Do not expose port `43110` directly to the public internet.

The container runs as UID/GID `1000:1000`. If the bind-mount directories are not writable by that user:

```sh
sudo chown -R 1000:1000 library .ushelf
```

Common operations:

```sh
docker compose logs -f ushelf
docker compose restart ushelf
docker compose down

git pull
docker compose up -d --build
```

To rebuild the disposable index against the same bind mounts:

```sh
docker compose stop ushelf
docker compose run --rm --no-deps ushelf node apps/server/dist/cli.js rebuild-index
docker compose up -d
```

For a consistent backup, stop the service and copy `library/` and `recipes/`. `.ushelf/` does not need to be backed up.

### Configuration

| Variable               | Default     | Purpose                                                     |
| ---------------------- | ----------- | ----------------------------------------------------------- |
| `USHELF_ROOT`          | `.`         | Directory containing `library/`, `.ushelf/`, and `recipes/` |
| `USHELF_STATE_DIR`     | `.ushelf`   | Optional separate directory for disposable SQLite state     |
| `USHELF_HOST`          | `127.0.0.1` | Address published by the HTTP server or Compose             |
| `USHELF_PORT`          | `43110`     | HTTP port                                                   |
| `USHELF_WEB_BASE_PATH` | `/`         | Root or subpath where the web app and API are served        |

The installed CLI also accepts `USHELF_HOME` (default `~/.ushelf`) and `USHELF_IMAGE`. Use `ushelf config show` for effective values and `ushelf config set` for persistent host, port, base-path, or image overrides.

For a subpath deployment, use an absolute path such as `/reader/`. uShelf normalizes the trailing slash, and your reverse proxy must preserve the prefix.

## Repository map

```text
packages/core   Shared domain and storage layer
apps/cli        Native Cobra CLI and Docker lifecycle
apps/server     HTTP and CLI adapter
apps/mcp        stdio MCP adapter
apps/web        React and Vite reader
recipes         Versioned enrichment instructions
skills          Agent ingestion and library workflows
library         Canonical saved documents and history
```

Package-specific runtime notes live in the README inside each package.

## Development

Contributors need Node.js 24+, pnpm 10, Go 1.24+, and Docker.

```sh
git clone https://github.com/karamouche/ushelf.git
cd ushelf
pnpm install
cp .env.example .env
pnpm dev
```

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
pnpm format:check
pnpm validate:skills
go -C apps/cli vet ./...
```

Run the smallest relevant check while iterating. Build before `pnpm test:e2e`, because Playwright launches the compiled production server.
The E2E command also performs live ingestion checks against the documented X and blog fixtures, so it requires internet access and can fail when either upstream source is unavailable or changes its public metadata.

Contributions should preserve the central boundary: deterministic code captures and stores sources; a connected agent performs explicit, recipe-driven enrichment.

## Releasing

Run the **Release** workflow manually with the desired semantic version. The workflow opens a `release/vMAJOR.MINOR.PATCH` pull request containing the project-version updates. Merging that pull request verifies the merged commit, creates its version tag, publishes the CLI archives and container image, and creates the GitHub Release. Do not create the release tag beforehand.
