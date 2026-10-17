# uShelf CLI

The native `ushelf` command deploys uShelf servers, operates them, and connects agents to them. It is written in Go with Cobra. Product behavior lives in the TypeScript runtime image; the CLI orchestrates where that image runs and relays agent traffic to it.

## Architecture

```text
internal/cli        Cobra commands, the context store, and deployment drivers
internal/api        HTTP client for a uShelf server (HTTPS-only outside loopback)
internal/mcpbridge  stdio ↔ Streamable HTTP relay used by `ushelf mcp`
internal/kindle     Amazon Send to Kindle sign-in and credential handling
cmd/ushelf-kindle-bridge  Helper shipped in the runtime image for the server
```

A **context** is a named server: its driver, deployment settings, URL, and credentials. Drivers implement the `Deployment` interface (`Apply`, `Stop`, `State`, `Logs`, `Diagnose`):

| Driver     | Implementation     | Notes                                                                     |
| ---------- | ------------------ | ------------------------------------------------------------------------- |
| `local`    | `DockerDeployment` | Local daemon, bind mounts under the uShelf home, publishes on loopback    |
| `ssh`      | `DockerDeployment` | `docker --host ssh://…`, `ushelf-data` volume, optional Caddy HTTPS proxy |
| `fly`      | `FlyDeployment`    | `flyctl`, one Machine, `ushelf_data` volume, secrets imported over stdin  |
| `external` | none               | Registered with `context add`; only API-based commands apply              |

Docker drivers also implement `Maintainer` for offline `rebuild-index` and `import`, which pause the service and run a one-shot container without integration secrets.

## Files

The CLI owns `~/.ushelf` by default (`--home` or `USHELF_ROOT` moves it):

```text
config.json       current context and each context's spec (no secrets)
credentials.json  per-context API token and app password, mode 0600
assets/skills/    skills downloaded from servers, linked by `ushelf setup`
library/ recipes/ state/ secrets/   data of the local driver only
```

Context selection precedence is `--context`, then `USHELF_CONTEXT`, then the saved current context. `ushelf start` without any context deploys `local`.

Secrets never appear in process arguments: Docker receives them through a temporary owner-only `--env-file` and Fly.io through `fly secrets import` on stdin. Remote contexts always require an app password, read from `USHELF_APP_PASSWORD` or prompted without echo.

## Command output

Commands that change state report each long-running step on stderr and write their final result to stdout as plain text:

```text
==> Preparing the uShelf home at /Users/you/.ushelf...
==> Creating the uShelf service...
==> Waiting for uShelf to become ready...
==> Waiting for http://127.0.0.1:43110/ to accept requests...
Done: uShelf 1.2.3 is ready at http://127.0.0.1:43110/ (context local)
```

If a Docker deployment becomes unhealthy or times out, the CLI includes a short recent log excerpt and points to `ushelf logs --tail 200` and `ushelf doctor`. `ushelf mcp` reserves stdout exclusively for protocol messages and answers any request it cannot relay with a JSON-RPC error.

## Connectors

Hosted AI apps such as Claude (web, desktop, mobile) and ChatGPT cannot run `ushelf mcp`. They connect to the server's `/mcp` endpoint directly and sign in with OAuth, and the owner approves each one with the app password. `ushelf connectors` prints the URL to add as a custom connector and lists the authorized connectors through the server's token-only API. `ushelf connectors revoke CLIENT_ID` (or `--all`) disconnects them immediately.

## Kindle setup

`ushelf kindle setup` performs Amazon sign-in locally, then uploads the device credential to the current context's server through its token-only API. If the upload fails, the new Amazon registration is deregistered. `ushelf kindle status` and `ushelf kindle disconnect` also go through the server; `--skip-deregister --yes` removes a credential that Amazon has already invalidated.

## Development

```sh
go -C apps/cli test ./...
go -C apps/cli vet ./...
go -C apps/cli build -o dist/ushelf ./cmd/ushelf
apps/cli/dist/ushelf --help
```

Development builds use `ghcr.io/karamouche/ushelf:latest` unless `deploy --image` or `ushelf config set image` selects another image, such as one built with `docker build -t ushelf:dev .`.

Never direct tests at a real uShelf home. Use `--home` with a temporary directory, inject a fake `Runner`, and serve the API from `httptest`.
