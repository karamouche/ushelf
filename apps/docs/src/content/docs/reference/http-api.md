---
title: HTTP API
description: The server routes used by the reader, the CLI, and agents.
---

All routes are served under `USHELF_WEB_BASE_PATH`. The reader uses the browser routes; the CLI and agents authenticate with `Authorization: Bearer <API token>`. See the [Security model](../../deploy/security/).

## Public

| Route                                 | Purpose                                                        |
| ------------------------------------- | -------------------------------------------------------------- |
| `GET /api/health`                     | Content-free health check; reports whether sign-in is required |
| `GET /auth/login`, `POST /auth/login` | Browser sign-in when a password is configured                  |

## OAuth for connectors

Served only when an app password is configured. See [Claude and ChatGPT apps](../../agents/claude-and-chatgpt/#how-it-works).

| Route                                                                                                               | Purpose                                                                               |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `GET /.well-known/oauth-protected-resource`, also at the root as `/.well-known/oauth-protected-resource/<base>/mcp` | Protected resource metadata (RFC 9728)                                                |
| `GET /.well-known/oauth-authorization-server`, also at the root as `/.well-known/oauth-authorization-server/<base>` | Authorization server metadata (RFC 8414), also at `/.well-known/openid-configuration` |
| `POST /oauth/register`                                                                                              | Dynamic client registration (RFC 7591)                                                |
| `GET /oauth/authorize`, `POST /oauth/authorize`                                                                     | Consent page; the owner approves with the app password                                |
| `POST /oauth/token`                                                                                                 | Authorization-code (S256 PKCE) and refresh-token grants                               |
| `POST /oauth/revoke`                                                                                                | Token revocation (RFC 7009)                                                           |

## Library

Available to browser sessions and to token clients.

| Route                                   | Purpose                                                                      |
| --------------------------------------- | ---------------------------------------------------------------------------- |
| `GET /api/items`                        | List or search items (`q`, `status`, `sourceType`, `tag`, `limit`, `offset`) |
| `GET /api/items/:id`                    | Read one item                                                                |
| `GET /api/items/:id/media/:filename`    | Serve a validated local media file                                           |
| `GET /api/items/:id/original`           | Serve a retained original PDF                                                |
| `PATCH /api/items/:id/reading`          | Update reading status and progress                                           |
| `POST /api/items/:id/kindle-deliveries` | Send an item to a Kindle device                                              |
| `GET /api/kindle/status`                | Kindle connection status                                                     |
| `GET /api/kindle/devices`               | Registered Kindle devices                                                    |
| `GET /api/recipes`                      | Available recipes                                                            |
| `POST /api/auth/logout`                 | End a browser session                                                        |

## Token only

| Route                                                  | Purpose                                                                                          |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `POST /mcp`                                            | MCP over stateless Streamable HTTP (requests up to 16 MiB); also accepts connector access tokens |
| `GET /api/connectors`                                  | List authorized OAuth connectors                                                                 |
| `DELETE /api/connectors`                               | Revoke every connector                                                                           |
| `DELETE /api/connectors/:clientId`                     | Revoke one connector                                                                             |
| `GET /api/server`                                      | Server version; verifies the token                                                               |
| `GET /api/agent/skills`                                | The skills bundled with this server version                                                      |
| `PUT /api/kindle/credential`                           | Store a Kindle credential registered by the CLI                                                  |
| `DELETE /api/kindle/credential?deregister=true\|false` | Remove the Kindle credential, optionally deregistering it                                        |

Errors use `{ "error": "…" }`, and Kindle errors add a stable `code`.
