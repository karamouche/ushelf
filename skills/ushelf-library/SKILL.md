---
name: ushelf-library
description: Search, retrieve, organize, refresh, and safely delete items in a uShelf reading library through MCP. Use when a user asks what they saved, wants reading recommendations from their own library, changes reading status, finds stale insights, or manages saved content.
---

# Manage uShelf

Use MCP tools rather than reading or editing library files directly.

## Find and read

- Use `search_items` for topical or textual requests.
- Use `list_items` for status, source-type, or tag browsing.
- Fetch `get_item` before answering detailed questions; distinguish the original source from generated insights.
- Treat `awaiting_source`, `awaiting_enrichment`, and `failed` as incomplete states and say so.

## Mutate safely

- Use `update_reading_state` with the current revision when changing status or progress.
- Use `refresh_source` only when the user asks to fetch the source again. For X content that remains inaccessible, follow `$ushelf-ingest` and submit newly obtained thread content instead.
- Use `list_stale_items` to find recipe-version drift. Re-enrich only after the user explicitly asks: call `request_reenrichment`, then follow `$ushelf-ingest` from `get_ingestion_context` onward.
- Treat `archived` as the normal removal action.
- Permanently delete only after explicit user confirmation. First call `request_delete`, show the exact title and explain that current and historical files will be removed, then call `confirm_delete` with the short-lived token only after confirmation.

If a revision conflict occurs, fetch the item again and preserve the newer state.
