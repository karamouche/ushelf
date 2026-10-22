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

Without a password, the server answers only requests addressed to `localhost`, `127.0.0.1`, or `[::1]`, and replies `421` to any other host name; requests carrying the API token are always accepted. This keeps web pages from reaching the reader through DNS rebinding. It is not authentication: any program on this machine, or another container on the same Docker network, can still reach the reader. Set a password if you share the machine.

Publishing on any other address, such as `--host 0.0.0.0` or a LAN address, makes the reader reachable from the network, so the CLI then requires an app password: `deploy` reads it from `USHELF_APP_PASSWORD` or prompts for it, `config set host` refuses such an address until a password is set, and `config unset app-password` refuses to remove it.

## Operations

```sh
ushelf status
ushelf logs --follow
ushelf rebuild-index
ushelf import /absolute/path/to/item.md
```

See [Maintenance and backups](../../guides/maintenance/).
