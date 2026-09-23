<p align="center">
  <img src="docs/assets/ushelf-hero.svg" alt="uShelf - a quiet place for unfinished reading" width="100%" />
</p>

<p align="center">
  <strong>A personal, agent-native library for the writing worth keeping.</strong><br />
  Capture deterministically. Enrich with your agent. Keep everything as readable Markdown.
</p>

<p align="center">
  <img alt="Node.js 24+" src="https://img.shields.io/badge/Node.js-24%2B-111111?style=flat-square" />
  <img alt="pnpm 11" src="https://img.shields.io/badge/pnpm-11-111111?style=flat-square" />
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

1. Ask your connected agent to save something from the web or attach a PDF.
2. uShelf captures and normalizes the source with deterministic code.
3. The agent follows a versioned recipe to add cited summaries, insights, and tags.
4. You search and read everything in the web app, while the canonical record stays in Markdown.

## Quick start

Install the native CLI on macOS or Linux. Docker is required for a local library; it is not required when connecting to a remote uShelf.

```sh
curl -fsSL https://github.com/karamouche/ushelf/releases/latest/download/install.sh | sh
```

Then check your installation and start uShelf:

```sh
ushelf doctor
ushelf start
```

Next, connect the agent client you use:

```sh
ushelf setup codex
# or: ushelf setup claude-code
# or: ushelf setup all
```

Open the reader at [http://127.0.0.1:43110](http://127.0.0.1:43110), or run `ushelf open`. You can now ask the connected agent to save a URL or an attached PDF. Your library, recipes, configuration, optional Kindle credential, and disposable index live under `~/.ushelf`.

Useful lifecycle commands:

```sh
ushelf status
ushelf logs --follow
ushelf stop
ushelf update
```

The CLI downloads a release-matched container image. Node.js, pnpm, a repository clone, and Docker Compose are not required for normal use.

uShelf automatically creates its configuration, library, recipes, state, and versioned agent assets under `~/.ushelf` when needed.

The installer supports macOS and Linux on amd64 and arm64; Windows users can run it under WSL.

### CLI reference

| Command                | Purpose                                                         |
| ---------------------- | --------------------------------------------------------------- |
| `ushelf start`         | Initialize local files and start or reconcile the reader/API    |
| `ushelf stop`          | Remove the managed container without deleting data              |
| `ushelf status`        | Show health, URL, version, image, and home                      |
| `ushelf logs`          | Read or follow managed service logs                             |
| `ushelf open`          | Open the reader in the system browser                           |
| `ushelf mcp`           | Run local stdio MCP or bridge stdio to remote MCP               |
| `ushelf setup CLIENT`  | Configure Codex, Claude Code, ChatGPT, or Claude Desktop        |
| `ushelf doctor`        | Check Docker, filesystem, port, image, recipe, and client setup |
| `ushelf update`        | Verify and install the latest CLI and matching image            |
| `ushelf rebuild-index` | Rebuild disposable SQLite state from Markdown                   |
| `ushelf import FILE`   | Import a validated Markdown item                                |
| `ushelf kindle`        | Connect, inspect, or disconnect Send to Kindle                  |
| `ushelf config`        | Inspect or update persistent configuration                      |
| `ushelf version`       | Show CLI build and runtime image information                    |
| `ushelf connect URL`   | Authorize this CLI with a remote uShelf using a browser         |
| `ushelf disconnect`    | Revoke the remote grant and select local                        |
| `ushelf target`        | Show or select the local or remote library                      |
| `ushelf export FILE`   | Export a versioned archive of library and recipes               |
| `ushelf migrate`       | Copy the stopped local library to an empty remote               |

## Connect your agent

Configure Codex, Claude Code, or both. This registers `ushelf mcp` at user scope and links the bundled workflows into the client's personal skill directory.

```sh
ushelf setup codex
ushelf setup claude-code
# or: ushelf setup all
```

Use `ushelf setup <client> --print` to inspect the exact registration command without making changes.

If an existing `ushelf` MCP entry or skill path points somewhere else, setup stops without overwriting it. Inspect the conflict first, then rerun with `--force` only when you intend to replace it.

For a remote library, first run `ushelf connect https://your-shelf.example`. The CLI uses browser-based device authorization, keeps its revocable credential in owner-only `~/.ushelf/credentials/remote.json`, and selects remote. `ushelf mcp` then bridges Codex or Claude Code to the remote HTTPS MCP endpoint without Docker. Use `ushelf target use local|remote` to switch libraries and `ushelf target status` to check the active one. `ushelf disconnect` revokes the remote grant and returns to local.

ChatGPT Desktop and Claude Desktop connect directly to the remote `/mcp` URL via OAuth, without running the CLI bridge. Run `ushelf setup chatgpt` or `ushelf setup claude-desktop` for guided steps, or open `/connections` on your remote reader. `ushelf setup all` configures the automatable clients and presents the desktop steps. Client connector menus change over time; use the current client's custom MCP connector flow and verify the URL and granted scopes before approving it.

See the [client compatibility check](docs/remote-compatibility.md) for the versions inspected and the live-deployment checks still needed.

Then try:

```text
Save this URL to uShelf.
Search my uShelf for writing about local-first software.
Show me unread pieces tagged architecture.
Send the saved post about local-first software to my Kindle.
```

## Send a saved item to Kindle

Connect an Amazon account from the native CLI, then use **Send to Kindle** in any reader page or ask your connected agent to send an already-saved item:

```sh
ushelf kindle setup
ushelf kindle status
```

The CLI opens Amazon's sign-in page and stores the resulting device credential at `~/.ushelf/secrets/kindle.json` with owner-only permissions. The reader or agent generates a reflowable EPUB from the canonical saved source and its local images, resolves one registered device, and sends without retaining an Amazon cloud-library copy. Insights are not included. After a successful delivery, uShelf remembers that device in local state and selects it by default next time when it is still registered; an agent asks you to choose when several devices are available and no valid preference exists.

This integration is unofficial and uses Amazon's undocumented Send to Kindle protocol through [`cyrgim/stk`](https://github.com/cyrgim/stk). Amazon may change or disable it without notice. Disconnect it with `ushelf kindle disconnect`.

## What is included

| Layer            | What it does                                                                                                                 |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **CLI**          | Native installation, Docker lifecycle, updates, maintenance, and agent-client setup                                          |
| **Core**         | URL safety, extraction, schemas, recipes, Markdown persistence, SQLite indexing, and all domain rules                        |
| **MCP**          | Ingestion, enrichment, search, reading state, Kindle delivery, refresh, re-enrichment, and confirmation-gated deletion tools |
| **HTTP server**  | A thin Hono API, production web hosting, index rebuilding, and Markdown import commands                                      |
| **Web reader**   | A responsive React library and reader with full-text search, filters, reading progress, and local Mermaid rendering          |
| **Agent skills** | Guided ingestion and library-management workflows that stay in sync with the MCP contract                                    |

Extraction includes Readability for articles, layout-aware PDF.js text and embedded-figure extraction for attached PDFs, local image capture, sanitization, response and redirect limits, and private-network protections. PDF extraction joins wrapped paragraphs and conservatively recovers headings, lists, and simple tables as Markdown. X sources use a limited public extraction path with an explicitly agent-supplied fallback. PDF attachments are limited to 10 MiB and must contain embedded text; remote PDF URLs, OCR, vector-diagram reconstruction, complex multi-column layouts, DOCX, and PPTX are not yet supported.

## Markdown at the core

| Path                         | Purpose                                               |
| ---------------------------- | ----------------------------------------------------- |
| `~/.ushelf/library/items/`   | Canonical current Markdown documents                  |
| `~/.ushelf/library/history/` | Archived enrichment revisions                         |
| `~/.ushelf/library/files/`   | Original PDFs and content-addressed item media        |
| `~/.ushelf/recipes/`         | Editable, hash-versioned agent instructions           |
| `~/.ushelf/state/ushelf.db`  | Rebuildable search index and transient workflow state |
| `~/.ushelf/secrets/`         | Owner-readable optional integration credentials       |

Markdown remains the source of truth. Canonical URLs deduplicate web ingestion, original-file hashes deduplicate PDF ingestion, content hashes detect source changes, recipe hashes identify stale enrichment, and revisions protect concurrent updates. If the index disappears, restore it with:

```sh
ushelf rebuild-index
```

To import an externally edited validated Markdown item, run:

```sh
ushelf import /absolute/path/to/item.md
```

Rendered images are downloaded into `library/files/<item-id>/media/` and referenced from canonical Markdown with portable relative paths. The reader serves only those validated local assets and never loads remote Markdown images. Retained PDFs can be opened from their document reader; embedded raster figures are extracted into the page-ordered Markdown, which remains the canonical searchable record.

## Run continuously with Docker Compose

The Compose setup builds the API and reader into one container, restarts after failures or reboots, and keeps canonical data on the host.

```sh
cp .env.example .env
printf 'USHELF_UID=%s\nUSHELF_GID=%s\n' "$(id -u)" "$(id -g)" >> .env
mkdir -p "$HOME/.ushelf/library/items" "$HOME/.ushelf/library/history" \
  "$HOME/.ushelf/recipes" "$HOME/.ushelf/state" "$HOME/.ushelf/secrets"
chmod 700 "$HOME/.ushelf/secrets"
test -f "$HOME/.ushelf/recipes/default.md" || \
  cp recipes/default.md "$HOME/.ushelf/recipes/default.md"
docker compose up -d --build
docker compose ps
```

Compose uses `~/.ushelf` by default, matching the native CLI and direct server or MCP processes. Configure Kindle credentials with `ushelf kindle setup`. To use another location, set an absolute `USHELF_ROOT` in `.env` and prepare the same directory layout there. The `.env` file itself is optional; when present, Compose loads it automatically. Set `USHELF_UID` and `USHELF_GID` to your host user and group IDs so the service and maintenance container can access the host-owned files.

This Compose setup is local mode and binds to `127.0.0.1:43110`. Local mode has no HTTP authentication: do not expose it directly to the public internet. For personal remote access, use the separate remote-mode deployment below.

The image defaults to UID/GID `1000:1000` when used directly. Compose uses the IDs in `.env`, which avoids changing ownership of the host files.

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
docker compose run --rm --no-deps maintenance rebuild-index
docker compose up -d
```

For a consistent backup, stop the service and copy `library/` and `recipes/`. SQLite state does not need to be backed up. Back up the root's `secrets/` directory separately only if you want to preserve optional integration credentials.

## Run a personal remote uShelf

Remote mode is one owner, one process, one writable persistent `/data` volume, and one stable HTTPS origin. It is not a hosted multi-user service. Bring any container host and reverse proxy you like; uShelf does not provision a host or TLS certificate. Pin the OCI image to the same release as your native CLI, and do not run horizontal replicas against one volume.

The [remote Compose example](compose.remote.yaml) publishes the service only on the host loopback interface. Set `USHELF_PUBLIC_URL=https://your-shelf.example` and route that origin's root path through your TLS-terminating proxy to port `43110`. The proxy must preserve the request path, method, body, `Authorization`, `Cookie`, `Origin`, and `Host` headers. Configure it to pass streaming MCP responses without buffering, allow request bodies larger than the existing 10 MiB PDF limit (allow at least 16 MiB), and allow long-lived requests and SSE-safe timeouts. Do not rewrite `X-Forwarded-Host` or `X-Forwarded-Proto` to a different public origin. Only the configured `USHELF_PUBLIC_URL` is trusted for OAuth and security-sensitive URLs. WebSockets are not required today, but avoid proxy rules that break upgrade or streaming traffic.

```sh
export USHELF_PUBLIC_URL=https://your-shelf.example
export USHELF_IMAGE=ghcr.io/karamouche/ushelf:YOUR_CLI_VERSION
docker compose -f compose.remote.yaml up -d
docker compose -f compose.remote.yaml logs -f ushelf
```

On first start, read the one-time claim code from server logs and open `https://your-shelf.example/setup`. After creating the owner, registration is permanently closed. Use a strong password. The server stores sessions, OAuth grants, and its generated signing secret in `/data/auth/`, separate from disposable `/data/state/ushelf.db`. You may supply `USHELF_AUTH_SECRET` instead of a generated secret, but keep it stable and private. `/api/health` intentionally reveals only `{"ok":true}`; it does not expose the library or owner.

Use `/connections` to see the MCP URL, approve client connections, and revoke grants. `ushelf connect` uses the browser device flow for the CLI bridge; ChatGPT Desktop and Claude Desktop use the direct OAuth connector. Grant only the scopes a client needs: `ushelf:read`, `ushelf:write`, `ushelf:kindle`, and, when a long-lived connection is desired, `offline_access`. Permanent deletion still requires the separate two-step confirmation in uShelf. If you lose the owner password, run `node apps/server/dist/cli.js reset-password` inside the server container, use its short-lived code at `/reset`, and reconnect clients afterward; reset revokes existing sessions and grants.

To move an existing local library once, connect the CLI to the empty remote, switch back with `ushelf target use local`, then run `ushelf migrate`. Add `--include-kindle` only if you explicitly want the Kindle credential transferred. The command stops local mutation while making a versioned, SHA-256-verified archive, validates it on the remote, rebuilds the index, and selects remote only after the server confirms completion. The local library remains untouched as a backup. This is not synchronization. `ushelf export FILE` creates the same portable archive without migrating.

Back up the entire remote `/data` volume while the service is stopped, especially `library/`, `recipes/`, `auth/`, and optional `secrets/`; `state/` can be rebuilt. Protect backups like credentials. For upgrades, keep one process, take a backup first, deploy a matching release image, and wait for `/api/health` before reconnecting clients. Do not expose the container's plain HTTP port directly on a public interface.

### Configuration

| Variable               | Default                 | Purpose                                                          |
| ---------------------- | ----------------------- | ---------------------------------------------------------------- |
| `USHELF_ROOT`          | `~/.ushelf`             | Root containing `library/`, `recipes/`, `state/`, and `secrets/` |
| `USHELF_STATE_DIR`     | `<USHELF_ROOT>/state`   | Optional override for disposable SQLite state                    |
| `USHELF_HOST`          | `127.0.0.1`             | Address published by the HTTP server or Compose                  |
| `USHELF_PORT`          | `43110`                 | HTTP port                                                        |
| `USHELF_WEB_BASE_PATH` | `/`                     | Root or subpath where the web app and API are served             |
| `USHELF_SECRETS_DIR`   | `<USHELF_ROOT>/secrets` | Optional override for integration credentials                    |
| `USHELF_MODE`          | `local`                 | `remote` enables single-owner authentication and HTTP MCP        |
| `USHELF_PUBLIC_URL`    | —                       | Required HTTPS origin in remote mode; no subpath                 |
| `USHELF_AUTH_SECRET`   | generated and persisted | Optional stable authentication signing secret                    |

Without path overrides, host processes use `~/.ushelf` and keep `library/`, `recipes/`, `state/`, and `secrets/` directly beneath it. The service creates the writable directories it needs and seeds the bundled default recipe when it is missing. The `secrets/` directory remains optional until an integration is configured.

Set `USHELF_ROOT` to move the complete layout. Use `USHELF_STATE_DIR` or `USHELF_SECRETS_DIR` only when either directory must live outside that root. Containers use `/data` internally, backed by the selected host root.

The native CLI's `--home` flag overrides `USHELF_ROOT`. It also accepts `USHELF_IMAGE`. Use `ushelf config show` for effective values and `ushelf config set` for persistent host, port, base-path, or image overrides.

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

Contributors need Node.js 24+, pnpm 11, Go 1.25+, and Docker.

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
pnpm db:check
go -C apps/cli vet ./...
```

When changing the SQLite schema, edit the Drizzle schema in Core, run `pnpm db:generate --name=describe_the_change`, and review the checked-in SQL migration.

Run the smallest relevant check while iterating. Build before `pnpm test:e2e`, because Playwright launches the compiled production server.
The E2E command also performs live ingestion checks against the documented X and article fixtures, so it requires internet access and can fail when either upstream source is unavailable or changes its public metadata.

Contributions should preserve the central boundary: deterministic code captures and stores sources; a connected agent performs explicit, recipe-driven enrichment. See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution license terms.

## Releasing

Run the **Release** workflow manually with the desired semantic version. The workflow opens a `release/vMAJOR.MINOR.PATCH` pull request containing the project-version updates. Merging that pull request verifies the merged commit, creates its version tag, publishes the CLI archives and container image, and creates the GitHub Release. Do not create the release tag beforehand.

## License

uShelf is licensed under the [Apache License 2.0](LICENSE).
