---
title: Deploy anywhere
description: Choose where the uShelf server runs and how the CLI keeps track of it.
---

The uShelf server is one container image, released in lockstep with the CLI. You can run it on your laptop, on any Docker host you can reach over SSH, on Fly.io, or on any platform you already operate. Your machine keeps only the CLI and the MCP bridge.

## Targets

| Target                                                  | Where it runs                     | Library storage          | HTTPS                     |
| ------------------------------------------------------- | --------------------------------- | ------------------------ | ------------------------- |
| [Local Docker](../local/)                               | The local Docker daemon           | `~/.ushelf` on this host | Not needed on loopback    |
| [SSH with a domain](../ssh/)                            | Any Docker host reachable by SSH  | `ushelf-data` volume     | Managed Caddy certificate |
| [SSH with your own proxy](../ssh/#bring-your-own-https) | Any Docker host reachable by SSH  | `ushelf-data` volume     | Your proxy or Tailscale   |
| [Fly.io](../fly/)                                       | One Fly.io Machine                | `ushelf_data` Fly volume | Provided by Fly.io        |
| [Self-hosted](../self-hosted/)                          | Anywhere you deployed it yourself | Whatever you mounted     | Your responsibility       |

```sh
ushelf deploy local
ushelf deploy ssh me@vps.example.com --domain ushelf.example.com
ushelf deploy ssh me@nas.local --url https://nas.tailnet.ts.net
ushelf deploy fly --app my-ushelf --region cdg
ushelf context add homelab --url https://ushelf.example.com
```

## Contexts

Each deployment is saved as a **context**: a name, the driver that operates it, its settings, and its credentials. `ushelf deploy` creates or updates a context and makes it current.

```sh
ushelf context list
ushelf context use vps
ushelf --context fly status
```

Commands such as `start`, `stop`, `status`, `logs`, `open`, `config`, `doctor`, `mcp`, and `kindle` act on the current context. `--context NAME` or the `USHELF_CONTEXT` environment variable selects another one for a single command.

Redeploying a context keeps its saved settings and secrets unless flags override them, so `ushelf start` and `ushelf update` reconcile it in place:

```sh
ushelf config set base-path /reader/
ushelf start
```

`ushelf context remove NAME` forgets a context on this machine without touching the deployment or its library.

## Credentials

Every deployment gets a generated **API token** that authenticates the CLI and agents. Remote deployments also require a **reader password** for the browser. Both are stored in `~/.ushelf/credentials.json` with owner-only permissions. See the [Security model](../security/).

## Moving a library

Moving a library between deployments is not automated yet. Copy `library/` and `recipes/` from one data root to the other while both servers are stopped; the index rebuilds from Markdown on startup.
