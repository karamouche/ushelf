# uShelf CLI

The native `ushelf` command is the end-user entrypoint for the local reader, API, and MCP server. It is written in Go with Cobra and delegates product behavior to the existing TypeScript runtime image.

## Development

```sh
go -C apps/cli test ./...
go -C apps/cli build -o dist/ushelf ./cmd/ushelf
apps/cli/dist/ushelf --help
```

Development builds use `ghcr.io/karamouche/ushelf:latest` unless `--image` or `USHELF_IMAGE` selects a locally built image.

The CLI owns `~/.ushelf` by default:

```text
config.json  library/  recipes/  state/  assets/  secrets/
```

Configuration precedence is CLI flags, environment variables, `config.json`, then defaults. Supported persistent keys are `host`, `port`, `base-path`, `image`, and `app-password`; `USHELF_ROOT` changes the data root, while `--home` takes precedence over it.

Run `ushelf config set app-password` to enter and confirm the password without echoing it. It is stored in `~/.ushelf/secrets/app-password` with owner-only access and mounted read-only into the server container. Run `ushelf start` to apply it; later starts retain protection. `ushelf config show` displays only whether a password is configured. Run `ushelf config unset app-password` followed by `ushelf start` to remove protection. A nonempty `USHELF_APP_PASSWORD` environment value takes precedence over the saved password for that start.

## Command output

Commands that change local state report each long-running step on stderr and write their final result to stdout. The output is plain text without terminal animation, so it remains readable when redirected or captured in CI:

```text
==> Preparing the uShelf home at /Users/you/.ushelf...
==> Creating the uShelf service...
==> Waiting for uShelf to become ready...
Done: uShelf is ready at http://127.0.0.1:43110/
```

If startup becomes unhealthy or times out, the CLI includes a short recent service-log excerpt when available and points to `ushelf logs --tail 200` and `ushelf doctor`. Read-only commands retain their structured output, and `ushelf mcp` reserves stdout exclusively for protocol traffic.

## Kindle setup

The optional Kindle integration uses Amazon's unofficial Send to Kindle protocol. Connect it interactively, inspect the registered devices, or remove the credential with:

```sh
ushelf kindle setup
ushelf kindle status
ushelf kindle disconnect
```

The credential is stored owner-readable at `~/.ushelf/secrets/kindle.json`. It is mounted read-only into the reader and MCP containers so either the web UI or a connected agent can deliver saved items, but it is never mounted into maintenance containers or exposed by an MCP tool. If Amazon has already invalidated a credential, `ushelf kindle disconnect --local-only --yes` removes only the local copy.

Never direct tests at a real uShelf home. Use `--home` with a temporary directory and inject a fake `Runner` for unit tests.
