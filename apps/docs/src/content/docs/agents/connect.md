---
title: Connect an agent
description: Connect Claude Code, Codex, or another MCP client to your uShelf server.
---

The MCP endpoint lives on the server at `<server URL>/mcp` and speaks Streamable HTTP, authenticated with the context's API token. Agents reach it in one of two ways.

| Path                       | Clients                                                              | Server must be reachable from | Token stored in                   |
| -------------------------- | -------------------------------------------------------------------- | ----------------------------- | --------------------------------- |
| **Stdio bridge** (default) | Claude Code, Codex, Claude Desktop, any stdio client on your machine | Your machine                  | `~/.ushelf/credentials.json` only |
| **Direct HTTP**            | MCP clients that accept a URL and a bearer header, on any machine    | The client's machine          | The client's own configuration    |

## Stdio bridge

```sh
ushelf setup claude
ushelf setup codex
# or: ushelf setup all
```

Setup registers `ushelf --context NAME mcp` with the client at user scope. The agent launches it as a local stdio server, and it relays each request to the server over HTTPS with the context's token. Setup also links the skills published by that server into the client's personal skill directory, so the workflows always match the server version.

- The registration is **pinned to the current context**, so later `ushelf context use` calls never silently retarget the agent. To point an agent at another deployment, switch contexts and rerun setup with `--force`.
- `ushelf setup <client> --print` shows the exact registration command without making changes.
- If an existing `ushelf` MCP entry or skill path points somewhere else, setup stops without overwriting it. Inspect the conflict first, then rerun with `--force` only when you intend to replace it.

Prefer this path whenever the agent runs where the CLI is installed. The token never enters the agent's configuration, and redeploying, rotating the token, or moving the server to another target requires no change on the agent side. If the server is unreachable or rejects the token, the bridge answers with an MCP error instead of hanging.

## Direct HTTP

Use this path for a client on another machine, or one that does not launch local commands. It requires a remote context, because a local deployment listens only on loopback. The client stores the token itself, so treat its configuration as a secret, and repeat these steps after a token rotation or URL change.

```sh
# The MCP endpoint and token of the current context.
URL="$(ushelf context show | jq -r .url)mcp"
TOKEN="$(jq -r --arg name "$(ushelf context show | jq -r .name)" '.[$name].apiToken' ~/.ushelf/credentials.json)"

# Claude Code
claude mcp add --scope user --transport http ushelf "$URL" --header "Authorization: Bearer $TOKEN"

# Codex reads the token from an environment variable at launch.
export USHELF_API_TOKEN="$TOKEN"
codex mcp add ushelf --url "$URL" --bearer-token-env-var USHELF_API_TOKEN
```

Skills are not installed on this path. Install them separately where the client supports skills, for example from the `~/.ushelf/assets/skills/` directory created by `ushelf setup` on a machine with the CLI.

## Claude mobile and web apps

The Claude mobile and web apps add remote MCP servers as custom connectors. Anthropic's cloud reaches those over the public internet, and they do not accept a static bearer header. uShelf does not support them yet; that requires OAuth on the server.

## Try it

```text
Save this URL to uShelf.
Search my uShelf for writing about local-first software.
Show me unread pieces tagged architecture.
Send the saved post about local-first software to my Kindle.
```

The full tool list is in the [MCP reference](../../reference/mcp/).
