---
title: Security model
description: How uShelf authenticates the CLI, agents, and browsers.
---

uShelf has two kinds of clients and a credential for each.

| Credential       | Used by                         | How it is presented                       |
| ---------------- | ------------------------------- | ----------------------------------------- |
| **API token**    | The CLI, the MCP bridge, agents | `Authorization: Bearer …` on each request |
| **App password** | People using the web reader     | A sign-in form that sets a session cookie |

## API token

- `ushelf deploy` generates a 256-bit random token per context. Self-hosted servers set `USHELF_API_TOKEN` themselves; the server rejects tokens shorter than 32 characters.
- The MCP endpoint (`/mcp`) and administrative routes (server info, agent skills, Kindle credentials) accept only the token, never a browser session.
- Token requests skip the browser session and same-origin checks, because a bearer header is not sent automatically by browsers. A present but invalid token is always rejected.
- The CLI sends the token only over HTTPS, except to loopback addresses.

## App password

- Remote deployments made by the CLI always require one. Locally it is optional because the server listens on loopback.
- It covers the API, PDFs, media, and reader for browser sessions. Sign-in and the content-free health check remain public.
- Sign-in uses a `Secure`, `SameSite=Strict` cookie that expires after 12 hours, on server restart, or on password change. Failed sign-ins are rate-limited.

## Where secrets live

- On your machine, `~/.ushelf/credentials.json` holds each context's token and password with owner-only permissions. `config.json` contains no secrets, and `ushelf config show` and `ushelf context show` report secrets only as `configured` or `unset`.
- Secrets reach Docker through a temporary owner-only env file, and Fly.io through `fly secrets import` on stdin. They never appear in process arguments.
- The Kindle credential lives only on the server, in `secrets/kindle.json`, and is never returned by the API or MCP tools.

## Caching proxies

Responses use `Cache-Control: no-store`. If a proxy or CDN cached uShelf responses before you enabled a password, purge it, especially `/api/items/*/media/*`, and disable caching of protected responses.

Neither credential protects Docker or filesystem access on the host that runs the server.
