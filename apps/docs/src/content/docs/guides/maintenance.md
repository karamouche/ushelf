---
title: Maintenance and backups
description: Rebuild the index, import items, update, and back up your library.
---

## Rebuild the index

SQLite is a disposable index. If it is lost or drifts, rebuild it from Markdown:

```sh
ushelf rebuild-index
```

The CLI pauses the server, runs the rebuild in a one-shot container without integration secrets, and restores the server. This works for local and SSH deployments. On Fly.io and self-hosted servers, the server reconciles its index from Markdown on every start.

## Import a Markdown item

To import an externally edited, validated item document:

```sh
ushelf import /absolute/path/to/item.md
```

Imports are validated and rejected when their canonical URL already exists. Like `rebuild-index`, this is available for local and SSH deployments.

:::caution
Do not edit files under `library/` while the server is running. Use the agent, the reader, or `ushelf import`.
:::

## Updating

```sh
ushelf update --check
ushelf update
```

`update` downloads the latest release, verifies its checksum, and replaces the CLI. If the current context uses the release-matched image, it then redeploys that context with the new image and refreshes the agent skills that `ushelf setup` linked. Contexts that pin an image with `ushelf config set image` are left alone. Run `ushelf --context NAME start` to roll other contexts forward.

## Backups

For a consistent backup, stop the server and copy `library/` and `recipes/`. Copy `secrets/` if you want to keep the Kindle credential. The SQLite state is rebuildable and does not need a backup.

- **Local:** the files are under `~/.ushelf`.
- **SSH:** the files are in the `ushelf-data` Docker volume on the host.
- **Fly.io:** use Fly volume snapshots, or copy the files from `/data` with `fly ssh sftp`.

## Diagnose problems

```sh
ushelf status
ushelf doctor
ushelf logs --tail 200
```

If a Docker deployment becomes unhealthy during `start`, the error includes recent server logs.
