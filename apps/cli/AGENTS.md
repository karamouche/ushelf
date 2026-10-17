# CLI Agent Guide

Read the root `AGENTS.md`, root `README.md`, and this package's `README.md` before changing the CLI.

## Boundaries

- The Go CLI deploys and operates servers through drivers, manages contexts, configures agent clients, and relays MCP over HTTP. Domain behavior stays in `@ushelf/core`, reached only through the server's HTTP API.
- New deployment targets implement the `Deployment` interface (and `Maintainer` only if they can run offline jobs). Commands must not branch on driver names beyond `deploymentFor`.
- Use Cobra for the command tree. Keep subprocess, filesystem, browser, and network behavior behind small testable boundaries (`Runner`, `internal/api`, `internal/mcpbridge`).
- Preserve stdout exclusively for MCP protocol traffic in `ushelf mcp`; diagnostics go to stderr.
- Never put secrets in process arguments or `config.json`. Use `credentials.json`, env files, or stdin, and only send API tokens over HTTPS outside loopback.
- Never delete a library, data volume, or user recipes. `stop` removes or scales down compute only; index rebuilds must remain recoverable from Markdown.
- Keep the runtime image pinned to the CLI release version unless the user explicitly supplies an image override.

## Verification

```sh
go -C apps/cli test ./...
go -C apps/cli vet ./...
go -C apps/cli build -o dist/ushelf ./cmd/ushelf
```
