---
title: Installation
description: Install the native uShelf CLI on macOS or Linux.
---

The `ushelf` CLI deploys and operates uShelf servers and connects your agents to them. Install it on the machine where your agents run.

```sh
curl -fsSL https://github.com/karamouche/ushelf/releases/latest/download/install.sh | sh
```

The installer supports macOS and Linux on amd64 and arm64. On Windows, run it under WSL. It installs the binary into `~/.local/bin` and adds that directory to your shell's `PATH` when needed.

Node.js, pnpm, and a repository clone are never required for normal use.

## Requirements by deployment target

What else you need depends on where the server will run:

| Target                                    | Requirement on your machine                         |
| ----------------------------------------- | --------------------------------------------------- |
| [Local Docker](../../deploy/local/)       | Docker, running                                     |
| [Docker host over SSH](../../deploy/ssh/) | The Docker CLI and key-based SSH access to the host |
| [Fly.io](../../deploy/fly/)               | `flyctl`, signed in with `fly auth login`           |
| [Self-hosted](../../deploy/self-hosted/)  | Nothing beyond the CLI                              |

## Updating

```sh
ushelf update --check
ushelf update
```

`ushelf update` verifies the release checksum, replaces the CLI, and rolls the current context forward to the matching server image. See [Maintenance](../../guides/maintenance/#updating).
