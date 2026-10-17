---
title: Local Docker
description: Run uShelf with your local Docker daemon.
---

The `local` driver runs the server with your machine's Docker daemon and keeps the library under `~/.ushelf`, where you can read the Markdown directly.

```sh
ushelf deploy local
# equivalent on first run:
ushelf start
```

The container publishes on `127.0.0.1:43110`. Override the address or port when needed:

```sh
ushelf deploy local --host 127.0.0.1 --port 43120
```

## What the CLI runs

- A read-only, `no-new-privileges` container named `ushelf` that runs as your user and restarts automatically.
- Bind mounts for `library/`, `state/`, and `secrets/`, and a read-only mount for `recipes/`.
- The API token and optional app password, passed through a temporary owner-only env file rather than the command line.

`ushelf start` recreates the container only when the image, settings, or secrets changed. `ushelf stop` removes the container and leaves the library untouched.

## Password

A local server bound to loopback does not need a reader password. To add one:

```sh
ushelf config set app-password
ushelf start
```

## Operations

```sh
ushelf status
ushelf logs --follow
ushelf rebuild-index
ushelf import /absolute/path/to/item.md
```

See [Maintenance and backups](../../guides/maintenance/).
