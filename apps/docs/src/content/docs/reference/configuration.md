---
title: Configuration
description: Server environment variables and the CLI's files.
---

## Server environment variables

| Variable               | Default                 | Purpose                                                               |
| ---------------------- | ----------------------- | --------------------------------------------------------------------- |
| `USHELF_ROOT`          | `~/.ushelf`             | Root containing `library/`, `recipes/`, `state/`, and `secrets/`      |
| `USHELF_STATE_DIR`     | `<USHELF_ROOT>/state`   | Optional override for the disposable SQLite state                     |
| `USHELF_SECRETS_DIR`   | `<USHELF_ROOT>/secrets` | Optional override for integration credentials                         |
| `USHELF_HOST`          | `127.0.0.1`             | Address the HTTP server listens on                                    |
| `USHELF_PORT`          | `43110`                 | HTTP port                                                             |
| `USHELF_WEB_BASE_PATH` | `/`                     | Root or subpath where the reader, API, and MCP endpoint are served    |
| `USHELF_APP_PASSWORD`  | unset                   | Password for browser access to library content                        |
| `USHELF_API_TOKEN`     | unset                   | Bearer token, at least 32 characters, for the CLI, agents, and `/mcp` |

Containers use `/data` as `USHELF_ROOT`. Set `USHELF_ROOT` to move the complete layout; use `USHELF_STATE_DIR` or `USHELF_SECRETS_DIR` only when either directory must live outside that root.

For a subpath deployment, use an absolute path such as `/reader/`. uShelf normalizes the trailing slash, and a reverse proxy must preserve the prefix.

Without `USHELF_API_TOKEN`, the MCP endpoint and administrative routes are unavailable. Without `USHELF_APP_PASSWORD`, browser access needs no sign-in, so the server answers only requests addressed to `localhost`, `127.0.0.1`, or `[::1]` and returns `421` for any other `Host` unless the request carries the API token. Set a password to reach the reader through any other address.

## CLI files

The CLI keeps its own files in `~/.ushelf`; `--home` or `USHELF_ROOT` moves them.

| Path               | Purpose                                                     |
| ------------------ | ----------------------------------------------------------- |
| `config.json`      | The current context and each context's settings; no secrets |
| `credentials.json` | Each context's API token and app password, mode `0600`      |
| `assets/skills/`   | Skills downloaded from servers and linked by `ushelf setup` |

The local driver also stores its library under the same directory. See [Library and storage](../../concepts/library/).

## CLI environment variables

| Variable              | Purpose                                                                       |
| --------------------- | ----------------------------------------------------------------------------- |
| `USHELF_ROOT`         | CLI home, overridden by `--home`                                              |
| `USHELF_CONTEXT`      | Context for one command, overridden by `--context`                            |
| `USHELF_APP_PASSWORD` | Reader password used by `deploy` instead of prompting; at least 12 characters |
| `USHELF_API_TOKEN`    | Token used by `context add` instead of prompting                              |

Use `ushelf config show` to see the current context's effective settings. Secrets are reported only as `configured` or `unset`.
