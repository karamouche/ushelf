# Contributing to uShelf

Thank you for contributing to uShelf. Please open an issue before undertaking a large change, and read [`AGENTS.md`](AGENTS.md) for the engineering rules. Each package also has its own README and `AGENTS.md`.

## Development setup

Contributors need Node.js 24+, pnpm 11, Go 1.26+, and Docker.

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

When changing the SQLite schema, edit the Drizzle schema in Core, run `pnpm db:generate --name=describe_the_change`, and review the checked-in SQL migration. See [`packages/core/README.md`](packages/core/README.md) for FTS5 migrations.

## Documentation

User-facing documentation lives in [`apps/docs`](apps/docs) and is published at <https://karamouche.github.io/ushelf/>. Update the matching page when behavior changes, and preview it with:

```sh
pnpm docs:dev
```

Keep the root README to the pitch, quick start, and links into the docs.

## Guidelines

Contributions should preserve the central boundary: deterministic code captures and stores sources; a connected agent performs explicit, recipe-driven enrichment.

## License of contributions

Unless you explicitly state otherwise, any contribution intentionally submitted
for inclusion in uShelf is provided under the Apache License, Version 2.0,
without additional terms or conditions, as described in section 5 of that
license.
