---
title: Capture and enrichment
description: The boundary between deterministic capture and agent-driven enrichment.
---

uShelf splits every save into two stages with a strict boundary between them.

## Capture is deterministic

When an agent calls `ingest_url` or `ingest_file`, the server fetches and normalizes the source with ordinary code:

- **Articles** are extracted with Readability, sanitized, and converted to Markdown. Parsing and extraction run in a worker thread with memory and time limits, so a hostile page cannot stall the server.
- **PDF attachments** are parsed with PDF.js into page-scoped Markdown with joined paragraphs and conservative heading, list, and simple-table recovery. Raster figures are placed by page coordinates. Parsing and decoding run in a worker thread with memory and time limits.
- **X posts and threads** use a limited public extraction path. When it is blocked, the item waits in `awaiting_source` until the agent submits the content with `submit_source_content`. That content is recorded as agent-supplied, not independently verified.
- **Images** are validated and stored content-addressably; Mermaid diagrams are normalized to fenced `mermaid` blocks.

URL fetching accepts only HTTP(S), rejects credentials and private-network targets, and enforces response-size, timeout, and redirect limits. Capture never consumes model tokens.

## Enrichment is done by your agent

Once the source is captured, the agent calls `get_ingestion_context`, which returns the source, the recipe instructions, the recipe hash, and the item revision. The agent writes a short description and a set of tags, then calls `save_insights`. The description appears on the item's library card; the reader shows only the captured source.

The server validates the result before saving it:

- The recipe hash must match the current recipe, and the revision must match the current item.

Recipes define what the description and tags should capture; skills define how the agent drives the tools. See [Skills and recipes](../../agents/skills-and-recipes/).
