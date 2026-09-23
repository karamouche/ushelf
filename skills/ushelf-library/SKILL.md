---
name: ushelf-library
description: Search, retrieve, organize, send to Kindle, refresh, and safely delete items in a uShelf reading library through MCP. Use when a user asks what they saved, wants reading recommendations from their own library, sends saved content to Kindle, changes reading status, finds stale insights, or manages saved content.
---

# Manage uShelf

Use MCP tools rather than reading or editing library files directly.
The workflow is the same for local and personal remote shelves. Never request an OAuth token or try to bypass the owner's consent and scope choices.

## Find and read

- Use `search_items` for topical or textual requests.
- Use `list_items` for status, source-type, or tag browsing.
- Fetch `get_item` before answering detailed questions; distinguish the original source from generated insights.
- Treat `awaiting_source`, `awaiting_enrichment`, and `failed` as incomplete states and say so.

## Mutate safely

- Use `update_reading_state` with the current revision when changing status or progress.
- Send to Kindle only when the user explicitly asks to deliver an already-saved item. Do not ingest an unsaved URL as part of delivery; explain that it must be saved first.
- Immediately before delivery, call `list_kindle_devices`. Use the only registered device, or `preferredTargetSerial` when it identifies a currently registered device. If multiple devices remain and there is no preference, ask the user to choose by device name; include only a masked serial suffix when names are ambiguous.
- Call `send_to_kindle` with the resolved item ID and device serial. The explicit delivery request is sufficient confirmation. Report that the EPUB contains the saved source and local images but not generated insights, and include the returned SKU after success.
- If Kindle is not configured, direct the user to run `ushelf kindle setup`. Report other Kindle error codes without retrying an upload automatically.
- Use `refresh_source` only when the user asks to fetch a URL source again. PDF documents cannot be refreshed; ingest the new PDF as a file instead. For X content that remains inaccessible, follow `$ushelf-ingest` and submit newly obtained thread content instead.
- Use `list_stale_items` to find recipe-version drift. Re-enrich only after the user explicitly asks: call `request_reenrichment`, then follow `$ushelf-ingest` from `get_ingestion_context` onward.
- Treat `archived` as the normal removal action.
- Permanently delete only after explicit user confirmation. First call `request_delete`, show the exact title and explain that current and historical files will be removed, then call `confirm_delete` with the short-lived token only after confirmation.

If a revision conflict occurs, fetch the item again and preserve the newer state.
