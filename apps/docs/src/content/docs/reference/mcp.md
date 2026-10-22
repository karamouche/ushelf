---
title: MCP tools
description: The tools and resources uShelf exposes to agents.
---

The server exposes these tools and resources at `/mcp`, to the API token and to [OAuth connectors](../../agents/claude-and-chatgpt/) alike. Inputs are validated, and mutating tools accept item revisions to reject stale writes. Agents normally use them through the [skills](../../agents/skills-and-recipes/).

## Ingestion

| Tool                    | Purpose                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------- |
| `ingest_url`            | Create or return an item for a URL and extract its source deterministically        |
| `ingest_file`           | Create or return a document from an attached PDF (base64, at most 10 MiB)          |
| `get_ingestion`         | Inspect an item's current ingestion stage                                          |
| `submit_source_content` | Supply X source Markdown (at most 5 MiB) when public extraction is blocked         |
| `get_ingestion_context` | Return the source, recipe instructions, recipe hash, revision, and output contract |
| `save_insights`         | Validate and atomically save the item's description and tags                       |

## Library

| Tool                   | Purpose                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| `list_items`           | List items with optional status, source-type, and tag filters                              |
| `search_items`         | Full-text search across source text, insights, titles, and tags                            |
| `get_item`             | Read one complete item                                                                     |
| `update_reading_state` | Set reading status and progress, with optional revision check                              |
| `list_stale_items`     | Find items enriched with an older recipe version                                           |
| `refresh_source`       | Re-fetch a URL source; changed content archives insights and returns to pending enrichment |
| `request_reenrichment` | Archive current insights and mark the item pending, keeping its source                     |
| `request_delete`       | Issue a short-lived confirmation token; deletes nothing                                    |
| `confirm_delete`       | Permanently delete an item with its confirmation token                                     |

## Kindle

| Tool                  | Purpose                                                            |
| --------------------- | ------------------------------------------------------------------ |
| `list_kindle_devices` | List registered devices and the last successfully used one         |
| `send_to_kindle`      | Send a saved item's source and local images to a device as an EPUB |

## Resources

| URI                            | Content                                      |
| ------------------------------ | -------------------------------------------- |
| `ushelf://items/{id}/source`   | Normalized source Markdown of an item        |
| `ushelf://items/{id}/document` | Complete item metadata and Markdown, as JSON |
| `ushelf://recipes/{name}`      | A recipe's enrichment instructions           |
