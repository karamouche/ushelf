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

Configuration precedence is CLI flags, environment variables, `config.json`, then defaults. Supported persistent keys are `host`, `port`, `base-path`, and `image`; `USHELF_HOME` changes the data root.

## Kindle setup

The optional Kindle integration uses Amazon's unofficial Send to Kindle protocol. Connect it interactively, inspect the registered devices, or remove the credential with:

```sh
ushelf kindle setup
ushelf kindle status
ushelf kindle disconnect
```

The credential is stored owner-readable at `~/.ushelf/secrets/kindle.json`. It is mounted read-only into the reader and MCP containers so either the web UI or a connected agent can deliver saved items, but it is never mounted into maintenance containers or exposed by an MCP tool. If Amazon has already invalidated a credential, `ushelf kindle disconnect --local-only --yes` removes only the local copy.

Never direct tests at a real uShelf home. Use `--home` with a temporary directory and inject a fake `Runner` for unit tests.
