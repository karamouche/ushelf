---
title: Contributing
description: Set up a development environment and run the checks.
---

Contributors need Node.js 24+, pnpm 11, Go 1.25+, and Docker.

```sh
git clone https://github.com/karamouche/ushelf.git
cd ushelf
pnpm install
cp .env.example .env
pnpm dev
```

Development runs the API at `http://127.0.0.1:43110` and the Vite reader at `http://127.0.0.1:43111`.

## Connect an agent to the dev server

Set `USHELF_API_TOKEN` in `.env`, then register the dev server and print the agent registration:

```sh
ushelf context add dev --url http://127.0.0.1:43110
ushelf setup claude --print
```

Symlink the repository's skills instead of letting setup download them, so edits are picked up immediately:

```sh
ln -s "$PWD/skills/ushelf-ingest" ~/.claude/skills/ushelf-ingest
ln -s "$PWD/skills/ushelf-library" ~/.claude/skills/ushelf-library
```

## Checks

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
pnpm format:check
pnpm validate:skills
pnpm db:check
pnpm docs:build
go -C apps/cli vet ./...
```

Run the smallest relevant check while iterating. Build before `pnpm test:e2e`, because Playwright launches the compiled production server. The E2E suite also performs live ingestion checks against public article and X fixtures, so it needs internet access and can fail when those sources change.

## Database schema

When changing the SQLite schema, edit the Drizzle schema in Core, run `pnpm db:generate --name=describe_the_change`, and review the checked-in SQL migration. See the Core package README for FTS5 migrations.

## Documentation

This site lives in `apps/docs` and uses [Starlight](https://starlight.astro.build/). Preview it with:

```sh
pnpm docs:dev
```

Keep the root README short and link here for details.

## Guidelines

Contributions should preserve the central boundary: deterministic code captures and stores sources; a connected agent performs explicit, recipe-driven enrichment. The repository's `AGENTS.md` and each package's `AGENTS.md` describe the engineering rules. See `CONTRIBUTING.md` for the contribution license terms.
