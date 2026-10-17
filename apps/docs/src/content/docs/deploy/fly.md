---
title: Fly.io
description: Run uShelf as a Fly.io app with a persistent volume.
---

The `fly` driver runs the server as a single Fly.io Machine with a persistent volume, served over HTTPS at `https://APP.fly.dev`.

## Requirements

- [`flyctl`](https://fly.io/docs/flyctl/install/) installed and signed in with `fly auth login`.

## Deploy

```sh
ushelf deploy fly --app my-shelf --region cdg
```

The app name must be globally unique on Fly.io. Use `--org` to create the app in an organization other than your personal one.

On the first deploy, the CLI:

1. Creates the app if it does not exist.
2. Creates a 1 GB `ushelf_data` volume in the region.
3. Stores the API token and reader password as Fly secrets, sent over stdin.
4. Deploys the release-matched image with a generated `fly.toml`: one Machine with 1 GB of memory, the volume mounted at `/data`, forced HTTPS, and a health check on `/api/health`.

The Machine stops when idle and starts on the next request, so the first request after a pause takes a few seconds.

## Operations

```sh
ushelf status
ushelf logs --follow
ushelf stop     # scales to zero Machines; the volume is kept
ushelf start    # redeploys and starts a Machine
```

`rebuild-index` and `import` are not available on Fly.io, because they need direct access to the stopped volume. The server reconciles its index from Markdown every time it starts.

## Removing the app

The CLI never deletes data. To delete the app and its volume, use flyctl directly:

```sh
fly apps destroy my-shelf
ushelf context remove my-shelf
```
