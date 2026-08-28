# CLI Agent Guide

Read the root `AGENTS.md`, root `README.md`, and this package's `README.md` before changing the CLI.

## Boundaries

- The Go CLI orchestrates Docker, installation, configuration, and agent-client setup. Domain behavior stays in `@ushelf/core`.
- Use Cobra for the command tree. Keep subprocess, filesystem, browser, and network behavior behind small testable boundaries.
- Preserve stdout exclusively for MCP protocol traffic in `ushelf mcp`; pulls and diagnostics go to stderr.
- Never delete `~/.ushelf/library` or user recipes. Container removal and index rebuilds must remain recoverable from Markdown.
- Keep the runtime image pinned to the CLI release version unless the user explicitly supplies an image override.

## Verification

```sh
go -C apps/cli test ./...
go -C apps/cli vet ./...
go -C apps/cli build -o dist/ushelf ./cmd/ushelf
```
