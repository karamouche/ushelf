---
title: Skills and recipes
description: How skills guide your agent and recipes shape the descriptions it writes.
---

uShelf gives your agent two kinds of instructions: **skills** describe how to drive the MCP tools, and **recipes** describe what a saved description and its tags should contain.

## Skills

Skills are part of the product contract and ship with the server. `ushelf setup` downloads the ones matching the server version and links them into your client's skill directory.

| Skill            | Used when the user asks to…                                                             |
| ---------------- | --------------------------------------------------------------------------------------- |
| `ushelf-ingest`  | Save, bookmark, ingest, or summarize a URL, X post, thread, or attached PDF             |
| `ushelf-library` | Search or browse saved items, change reading status, send to Kindle, refresh, or delete |

Highlights of the ingestion workflow:

1. Start with `ingest_url`, or `ingest_file` with the exact PDF bytes in base64.
2. Report an already-ready duplicate instead of re-enriching it, unless asked.
3. For an X source in `awaiting_source`, obtain the content and call `submit_source_content`.
4. Call `get_ingestion_context`, follow the recipe using only the supplied source, and call `save_insights` with the returned recipe hash and revision.
5. On a revision or recipe conflict, fetch a fresh context and redo only the affected step.

The library skill archives rather than deletes by default, and permanently deletes only after explicit confirmation through `request_delete` and `confirm_delete`.

## Recipes

A recipe is a Markdown file in the server's `recipes/` directory. Its instructions are returned by `get_ingestion_context`, and its hash is recorded with every enrichment. The bundled `default` recipe asks for two things, both grounded in the captured source:

1. **Description**: one to three sentences on what the piece is and why it is worth reading, shown on the library card.
2. **Tags**: up to 12 short, lowercase topical tags.

When a recipe changes, its hash changes too, and `list_stale_items` finds items enriched with the older version. Ask your agent to re-enrich them explicitly; uShelf never spends tokens on its own.

For a local deployment, recipes live in `~/.ushelf/recipes/`. Remote deployments keep them in their data volume. The default recipe is copied there only when it is missing, so an existing deployment keeps its current copy until you delete or replace it.
