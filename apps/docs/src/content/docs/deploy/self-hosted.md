---
title: Self-hosted and Compose
description: Run the uShelf image on your own platform and register it with the CLI.
---

You can run the uShelf image on any platform, such as Docker Compose, Kubernetes, or a PaaS, and still use the CLI and MCP bridge against it.

## Run the image

The image is `ghcr.io/karamouche/ushelf:<version>`. Give it:

- A persistent volume mounted at `/data`.
- `USHELF_HOST=0.0.0.0` so it listens inside the container, and optionally `USHELF_PORT` (default `43110`).
- `USHELF_API_TOKEN`, a random string of at least 32 characters, for example from `openssl rand -base64 32`.
- `USHELF_APP_PASSWORD`, at least 12 characters, whenever the reader is reachable beyond loopback.
- HTTPS in front of it, preserving the original `Host` header.

The container runs as an unprivileged user. If it starts as root, for example on a platform with root-owned volumes, it takes ownership of `/data` and drops privileges before starting the server. See [Configuration](../../reference/configuration/) for every variable.

## Register it with the CLI

```sh
ushelf context add homelab --url https://ushelf.example.com
```

The CLI prompts for the token without echo (or reads `USHELF_API_TOKEN`), verifies it against the server, and makes the context current. Agent setup, Kindle, `status`, and `doctor` then work as usual. Lifecycle commands such as `start`, `stop`, and `logs` are left to the platform that runs it.

## Docker Compose from a repository clone

The repository's `compose.yaml` builds the image and stores the library on the host under `~/.ushelf`.

```sh
cp .env.example .env
printf 'USHELF_UID=%s\nUSHELF_GID=%s\n' "$(id -u)" "$(id -g)" >> .env
printf 'USHELF_API_TOKEN=%s\n' "$(openssl rand -base64 32)" >> .env
mkdir -p "$HOME/.ushelf/library/items" "$HOME/.ushelf/library/history" \
  "$HOME/.ushelf/recipes" "$HOME/.ushelf/state" "$HOME/.ushelf/secrets"
chmod 700 "$HOME/.ushelf/secrets"
test -f "$HOME/.ushelf/recipes/default.md" || \
  cp recipes/default.md "$HOME/.ushelf/recipes/default.md"
docker compose up -d --build
ushelf context add compose --url http://127.0.0.1:43110
```

To use another location, set an absolute `USHELF_ROOT` in `.env` and create the same directories there. `USHELF_UID` and `USHELF_GID` let the container access your files.

Common operations:

```sh
docker compose logs -f ushelf
docker compose restart ushelf
docker compose down

git pull
docker compose up -d --build
```

To rebuild the index against the same bind mounts:

```sh
docker compose stop ushelf
docker compose run --rm --no-deps maintenance rebuild-index
docker compose up -d
```

## Subpath deployments

To serve uShelf under a path such as `/reader/`, set `USHELF_WEB_BASE_PATH=/reader/` and include the path in the context URL. uShelf normalizes the trailing slash, and your reverse proxy must preserve the prefix.
