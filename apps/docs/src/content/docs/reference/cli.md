---
title: CLI
description: Every ushelf command and flag.
---

Run `ushelf --help` or `ushelf COMMAND --help` for the same information in your terminal.

## Global flags

| Flag             | Purpose                                                                |
| ---------------- | ---------------------------------------------------------------------- |
| `--context NAME` | Act on this context instead of the current one (also `USHELF_CONTEXT`) |
| `--home PATH`    | CLI home directory, default `~/.ushelf` (also `USHELF_ROOT`)           |

## Commands

| Command                                   | Purpose                                                                |
| ----------------------------------------- | ---------------------------------------------------------------------- |
| `ushelf deploy local\|ssh\|fly`           | Create or update a deployment and make it the current context          |
| `ushelf start`                            | Reconcile the current context, or deploy locally when none exists      |
| `ushelf stop`                             | Stop the server without deleting data                                  |
| `ushelf status`                           | Show deployment state, health, URL, and server and CLI versions        |
| `ushelf logs`                             | Read or follow server logs                                             |
| `ushelf open`                             | Open the reader in the system browser                                  |
| `ushelf context list\|use\|show`          | List, switch, or inspect contexts                                      |
| `ushelf context add\|remove`              | Register a self-deployed server, or forget a context                   |
| `ushelf config show\|set\|unset\|path`    | Inspect or change the current context's settings                       |
| `ushelf mcp`                              | Run the stdio MCP bridge to the current context                        |
| `ushelf setup codex\|claude\|all`         | Configure agent clients and link the server's skills                   |
| `ushelf doctor`                           | Check the platform, deployment, server health, token, and client setup |
| `ushelf update`                           | Install the latest CLI and roll the current context forward            |
| `ushelf rebuild-index`                    | Rebuild the search index from Markdown (local and SSH)                 |
| `ushelf import FILE`                      | Import a validated Markdown item (local and SSH)                       |
| `ushelf kindle setup\|status\|disconnect` | Connect, inspect, or disconnect Send to Kindle                         |
| `ushelf version`                          | Show the CLI build and the current context's image                     |

## deploy

Shared flags for every target:

| Flag               | Purpose                                                    |
| ------------------ | ---------------------------------------------------------- |
| `--name NAME`      | Context to create or update                                |
| `--image IMAGE`    | Runtime image, default the image matching this CLI release |
| `--base-path PATH` | URL path prefix for the reader, API, and MCP endpoint      |

### deploy local

| Flag     | Default     | Purpose               |
| -------- | ----------- | --------------------- |
| `--name` | `local`     | Context name          |
| `--host` | `127.0.0.1` | Address to publish on |
| `--port` | `43110`     | HTTP port             |

### deploy ssh USER@HOST[:PORT]

| Flag       | Default       | Purpose                                                    |
| ---------- | ------------- | ---------------------------------------------------------- |
| `--name`   | the host name | Context name                                               |
| `--domain` |               | Serve over HTTPS at this domain with a managed Caddy proxy |
| `--url`    |               | Public HTTPS URL when you run your own proxy               |
| `--host`   | `127.0.0.1`   | Remote address to publish on with `--url`                  |
| `--port`   | `43110`       | HTTP port                                                  |

Exactly one of `--domain` and `--url` is required. See [Docker host over SSH](../../deploy/ssh/).

### deploy fly

| Flag       | Default      | Purpose                                    |
| ---------- | ------------ | ------------------------------------------ |
| `--app`    |              | Globally unique Fly.io app name            |
| `--region` |              | Fly.io region code, such as `cdg` or `iad` |
| `--org`    | personal     | Fly.io organization for a new app          |
| `--name`   | the app name | Context name                               |

See [Fly.io](../../deploy/fly/).

## context add NAME --url URL

Registers a server deployed outside the CLI. The token is read from `USHELF_API_TOKEN` or prompted without echo, and verified before the context is saved. See [Self-hosted and Compose](../../deploy/self-hosted/).

## config

`config set` and `config unset` change the current context; run `ushelf start` to apply them. The available keys depend on the driver:

| Key            | Drivers                           | Purpose                                  |
| -------------- | --------------------------------- | ---------------------------------------- |
| `image`        | local, ssh, fly                   | Runtime image                            |
| `base-path`    | local, ssh, fly                   | Reader, API, and MCP URL prefix          |
| `host`         | local, ssh with `--url`           | Address to publish on                    |
| `port`         | local, ssh                        | HTTP port                                |
| `domain`       | ssh                               | HTTPS domain served by the managed proxy |
| `url`          | ssh with your own proxy, external | Server URL                               |
| `region`       | fly                               | Fly.io region                            |
| `app-password` | local, ssh, fly                   | Reader password, prompted without echo   |

## logs

| Flag             | Default | Purpose                                  |
| ---------------- | ------- | ---------------------------------------- |
| `-f`, `--follow` | off     | Follow log output                        |
| `--tail N`       | `200`   | Number of lines to show (Docker drivers) |

## setup

| Flag      | Purpose                                            |
| --------- | -------------------------------------------------- |
| `--print` | Print the registration commands without changes    |
| `--force` | Replace conflicting uShelf entries and skill links |

## kindle disconnect

| Flag                | Purpose                                                           |
| ------------------- | ----------------------------------------------------------------- |
| `--yes`             | Confirm without prompting                                         |
| `--skip-deregister` | Remove the credential without deregistering it (requires `--yes`) |

## update

| Flag      | Purpose                                   |
| --------- | ----------------------------------------- |
| `--check` | Check for an update without installing it |

## Output conventions

Commands that change state report each step on stderr, prefixed with `==>`, and write their final result to stdout, prefixed with `Done:`. The output is plain text, so it stays readable when captured in CI. `ushelf mcp` reserves stdout exclusively for MCP protocol messages.
