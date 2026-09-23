# uShelf CLI

The native `ushelf` command is the end-user entrypoint for a local or personal remote reader, API, and MCP server. It is written in Go with Cobra. Local runtime operations use the OCI image; a remote target uses authenticated HTTPS and a native stdio-to-HTTP MCP bridge without Docker.

## Development

```sh
go -C apps/cli test ./...
go -C apps/cli build -o dist/ushelf ./cmd/ushelf
apps/cli/dist/ushelf --help
```

Development builds use `ghcr.io/karamouche/ushelf:latest` unless `--image` or `USHELF_IMAGE` selects a locally built image.

The CLI owns `~/.ushelf` by default:

```text
config.json  credentials/  library/  recipes/  state/  assets/  secrets/
```

Configuration precedence is CLI flags, environment variables, `config.json`, then defaults. Supported persistent keys include `host`, `port`, `base-path`, `image`, `remote-url`, and `active-target`; `USHELF_ROOT` changes the data root, while `--home` takes precedence over it. Remote OAuth credentials stay in owner-only `credentials/remote.json` and are never mounted into local containers.

Use `ushelf connect URL` to authorize in the browser and select remote, `ushelf target use local|remote` to switch, and `ushelf disconnect` to revoke the grant. `ushelf setup codex` and `ushelf setup claude-code` register the active target's `ushelf mcp` command and skills. `ushelf setup chatgpt` and `ushelf setup claude-desktop` show direct remote OAuth connector instructions; both require a remote target. `ushelf setup all` handles the automatable clients and shows the remaining desktop steps.

`ushelf import`, `rebuild-index`, `export`, and Kindle commands act on the active target. `ushelf migrate` copies a stopped local library into an empty version-matched remote and selects remote only after verification. `start`, `stop`, `logs`, and local image lifecycle always remain local.

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

For a local target, the credential is stored owner-readable at `~/.ushelf/secrets/kindle.json` and mounted read-only into the reader and MCP containers. For a remote target, it is uploaded over authenticated HTTPS and removed locally after transfer. It is never exposed by an MCP tool. If Amazon has already invalidated a local credential, `ushelf kindle disconnect --local-only --yes` removes only that copy.

Never direct tests at a real uShelf home. Use `--home` with a temporary directory and inject a fake `Runner` for unit tests.
