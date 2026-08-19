---
name: ushelf-ingest
description: Save blog posts and X threads into uShelf and create recipe-driven, source-grounded insights through its MCP server. Use when a user asks to save, bookmark, ingest, capture, summarize, or add a URL or thread to their reading library.
---

# Ingest into uShelf

Use the uShelf MCP tools for every mutation. Never edit library Markdown directly.

## Workflow

1. Call `ingest_url` with the URL and requested recipe, or `default` when none is named.
2. If the returned item is a duplicate and already `ready`, report that it was already saved. Re-enrich only when explicitly requested.
3. Inspect the ingestion state:
   - For `awaiting_source` on an X thread, obtain the complete ordered thread through the agent's available browser/context, then call `submit_source_content`. Format each post under a heading and include its permalink. Never represent agent-supplied text as independently verified.
   - For `failed`, report the extraction error. Do not manufacture source text.
4. Call `get_ingestion_context`. Follow its recipe instructions using only the supplied source.
5. Produce every required typed field. Cite only URLs present in the source or the original URL. State uncertainty rather than adding unsupported claims.
6. Call `save_insights` with the exact `recipeHash` and item `revision` returned by the context call.
7. If saving reports a changed revision or recipe, fetch a fresh context and redo only the affected step. Do not overwrite concurrent updates.
8. Report the saved title, state, tags, and item ID.

Keep summaries compact. Put recipe-specific analysis in `bodyMarkdown`; do not repeat the summary or key points there.
