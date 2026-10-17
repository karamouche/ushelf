---
title: Quick start
description: Run a local uShelf library and connect your agent.
---

This guide runs uShelf with your local Docker daemon. To put the server somewhere that is always on, see [Deploy anywhere](../../deploy/overview/).

## 1. Start a local server

```sh
ushelf start
```

With no context configured, `start` deploys the `local` context: a container bound to `127.0.0.1:43110` with its library under `~/.ushelf`.

## 2. Connect your agent

```sh
ushelf setup claude
# or: ushelf setup codex
# or: ushelf setup all
```

This registers the `ushelf mcp` bridge with your agent client and installs the uShelf skills. See [Connect an agent](../../agents/connect/) for the details and alternatives.

## 3. Save and read

Open the reader at [http://127.0.0.1:43110](http://127.0.0.1:43110), or run `ushelf open`. Then ask your agent:

```text
Save this URL to uShelf.
Search my uShelf for writing about local-first software.
Show me unread pieces tagged architecture.
Send the saved post about local-first software to my Kindle.
```

## Check your setup

```sh
ushelf status
ushelf doctor
```

`doctor` checks the platform, the deployment, server health, the API token, Kindle, and which agent clients are configured.
