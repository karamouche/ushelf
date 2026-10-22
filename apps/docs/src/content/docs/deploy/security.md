---
title: Security model
description: How uShelf authenticates the CLI, agents, and browsers.
---

uShelf has three kinds of clients and a credential for each.

| Credential                 | Used by                                   | How it is presented                                         |
| -------------------------- | ----------------------------------------- | ----------------------------------------------------------- |
| **API token**              | The CLI, the MCP bridge, local agents     | `Authorization: Bearer …` on each request                   |
| **App password**           | People using the web reader               | A sign-in form that sets a session cookie                   |
| **Connector access token** | Hosted AI apps such as Claude and ChatGPT | `Authorization: Bearer …` on `/mcp`, obtained through OAuth |

## API token

- `ushelf deploy` generates a 256-bit random token per context. Self-hosted servers set `USHELF_API_TOKEN` themselves; the server rejects tokens shorter than 32 characters.
- The MCP endpoint (`/mcp`) and administrative routes (server info, agent skills, Kindle credentials, connectors) never accept a browser session. Administrative routes accept only the API token; `/mcp` also accepts connector access tokens.
- Token requests skip the browser session and same-origin checks, because a bearer header is not sent automatically by browsers. A present but invalid token is always rejected.
- The CLI sends the token only over HTTPS, except to loopback addresses, and never follows a redirect with it. A redirect, such as a proxy sending `example.com` to `www.example.com`, means the context URL should point at the final address.

## App password

- Remote deployments made by the CLI always require one, and so do local deployments published on an address other than `127.0.0.1`, `::1`, or `localhost`. The CLI accepts only passwords of at least 12 characters. Otherwise it is optional because the server listens on loopback.
- Without a password, the server refuses to start unless it is exposed only on loopback: its listen address, or for a container the address its port is published on (`USHELF_PUBLISHED_HOST`), must be `127.0.0.1`, `::1`, or `localhost`.
- Without a password, the server also answers only requests whose `Host` is `localhost`, `127.0.0.1`, or `[::1]` (others get `421`), unless they carry the API token. This blocks DNS-rebinding pages. It is not authentication: a client other than a browser can send any `Host`, so anything that can reach the port, such as another container on the same Docker network, can use the reader.
- Reader writes accept only `application/json` bodies up to 16 KiB, so cross-site pages cannot send them without a CORS preflight.
- It covers the API, PDFs, media, and reader for browser sessions. Sign-in and the content-free health check remain public.
- Sign-in uses a `Secure`, `SameSite=Strict` cookie that expires after 12 hours, on server restart, or on password change. Failed sign-ins are rate-limited: after ten wrong passwords within a minute, every attempt is refused for the rest of that minute, even with the correct password, so the limit caps guessing. Existing sessions, API tokens, and connector tokens keep working; only new sign-ins and approvals wait.
- A server started with a password shorter than 12 characters logs a warning but still starts.

## OAuth connectors

- The server is its own OAuth 2.1 authorization server, enabled only when an app password is set. You approve each connector by entering the password on a consent page that names the address the app returns to. Approval attempts share the sign-in rate limit.
- Only the authorization-code flow with S256 PKCE is accepted. Redirect addresses must be HTTPS (or HTTP on loopback) and match the registration exactly.
- Access tokens last one hour and work only on `/mcp`. They never unlock the reader, the HTTP API, or administrative routes. Refresh tokens last 30 days and rotate on every use, and replaying an old one revokes the connection.
- Only SHA-256 digests of client secrets, codes, and tokens are stored, in the SQLite state.
- Changing the app password does not revoke connectors. Use `ushelf connectors revoke` to disconnect one app, or `--all` for every app. See [Claude and ChatGPT apps](../../agents/claude-and-chatgpt/).

## Where secrets live

- On your machine, `~/.ushelf/credentials.json` holds each context's token and password with owner-only permissions. `config.json` contains no secrets, and `ushelf config show` and `ushelf context show` report secrets only as `configured` or `unset`.
- Secrets reach Docker through a temporary owner-only env file, and Fly.io through `fly secrets import` on stdin. They never appear in process arguments.
- The Kindle credential lives only on the server, in `secrets/kindle.json`, and is never returned by the API or MCP tools.

## Caching proxies

Responses use `Cache-Control: no-store`. If a proxy or CDN cached uShelf responses before you enabled a password, purge it, especially `/api/items/*/media/*`, and disable caching of protected responses.

Neither credential protects Docker or filesystem access on the host that runs the server.
