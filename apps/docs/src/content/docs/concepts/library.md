---
title: Library and storage
description: How uShelf stores items as Markdown and why the index is disposable.
---

Markdown is the source of truth. SQLite is only a search index that can be rebuilt from it at any time.

## Layout

A local deployment keeps this layout under `~/.ushelf`. Remote deployments keep the same layout inside their data volume, mounted at `/data`.

| Path               | Purpose                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------- |
| `library/items/`   | Canonical current Markdown documents                                                    |
| `library/history/` | Archived enrichment revisions                                                           |
| `library/files/`   | Original PDFs and content-addressed item media                                          |
| `recipes/`         | Editable, hash-versioned agent instructions                                             |
| `state/ushelf.db`  | Rebuildable search index and transient workflow state, including connector OAuth grants |
| `secrets/`         | Owner-readable optional integration credentials                                         |

The server creates the directories it needs and seeds the bundled default recipe when it is missing. It never overwrites a local recipe.

## Integrity guarantees

- **Canonical URLs** deduplicate web ingestion, and **original-file hashes** deduplicate PDF ingestion.
- **Content hashes** detect source changes. A changed enriched source is archived before its insights are cleared.
- **Recipe hashes** identify enrichment produced by an older recipe version.
- **Revisions** protect concurrent updates: writes based on a stale revision are rejected.
- Markdown is written atomically, so a crash never leaves a half-written item.

## Media

Rendered images are downloaded into `library/files/<item-id>/media/` and referenced from canonical Markdown with portable relative paths. The reader serves only those validated local assets and never loads remote Markdown images.

Retained PDFs can be opened from their document reader. Embedded raster figures are extracted into the page-ordered Markdown, which remains the canonical searchable record.

## Rebuilding and importing

If the index disappears or drifts, rebuild it from Markdown, or import an externally edited item. See [Maintenance and backups](../../guides/maintenance/).
