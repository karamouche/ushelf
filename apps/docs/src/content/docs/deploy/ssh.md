---
title: Docker host over SSH
description: Run uShelf on a VPS, NAS, or homelab machine with Docker.
---

The `ssh` driver drives the Docker daemon of a remote host through `docker --host ssh://…`. Any machine with Docker and SSH access works: a VPS, a NAS, or a homelab server.

## Requirements

- Docker installed and running on the host, and your SSH user allowed to use it.
- Key-based SSH access from your machine (`ssh USER@HOST docker version` succeeds without a prompt).
- The Docker CLI on your machine. A local Docker daemon is not required.

## Managed HTTPS with a domain

```sh
ushelf deploy ssh me@vps.example.com --domain ushelf.example.com
```

Point the domain's DNS at the host and open ports 80 and 443. The CLI runs two containers on a private `ushelf` network:

- `ushelf`, the server, which publishes no ports.
- `ushelf-caddy`, a Caddy reverse proxy that obtains and renews a Let's Encrypt certificate and serves `https://ushelf.example.com`.

## Bring your own HTTPS

If you already terminate HTTPS, for example with a reverse proxy or Tailscale Serve, publish the server on the host and tell the CLI the public URL:

```sh
ushelf deploy ssh me@nas.local --url https://nas.tailnet.ts.net --host 127.0.0.1 --port 43110
```

The server is published on `--host:--port` of the remote host (loopback by default). Your proxy must forward to it and preserve the original `Host` header. The CLI refuses plain `http://` URLs for anything other than loopback.

## Password

Remote deployments always require a reader password. The CLI reads it from `USHELF_APP_PASSWORD` or prompts for it without echo on the first deploy, and reuses it afterwards.

## Storage and maintenance

The library lives in the `ushelf-data` Docker volume on the host. Maintenance commands work the same as locally and run against the remote daemon:

```sh
ushelf rebuild-index
ushelf import ./item.md
```

`import` streams the file over the SSH connection, so the file only needs to exist on your machine.

`ushelf stop` removes the containers and keeps the `ushelf-data` volume.
