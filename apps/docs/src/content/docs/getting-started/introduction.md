---
title: Introduction
description: What uShelf is and how a saved item flows through it.
---

Most read-later tools own the database and bolt AI onto the side. uShelf takes the opposite approach:

- **Your files are the product.** Every completed item lives as portable, readable Markdown.
- **Your agent does the thinking.** uShelf exposes an MCP server and recipe-driven workflows, not a bundled model.
- **Capture stays deterministic.** Web sources are extracted, sanitized, normalized, and checked before enrichment begins.
- **The index is disposable.** SQLite FTS5 makes the library fast to search and can always be rebuilt from Markdown.
- **Reading is first-class.** The web reader tracks inbox, reading, read, and archived states, plus scroll progress.

:::note
uShelf includes no model SDK, AI API key, embeddings store, or autonomous LLM process.
:::

## How it works

![uShelf architecture: agents and browsers use thin adapters around ShelfService, with Markdown as the canonical record and SQLite as a rebuildable index](../../../assets/ushelf-workflow.svg)

1. Ask your connected agent to save something from the web or attach a PDF.
2. uShelf captures and normalizes the source with deterministic code.
3. The agent follows a versioned recipe to add cited summaries, insights, and tags.
4. You search and read everything in the web app, while the canonical record stays in Markdown.

## What is supported

Articles use Readability. Attached PDFs use PDF.js to extract text and embedded figures. X has limited public extraction, with agent-supplied fallback content. uShelf also captures images locally and blocks unsafe URLs.

PDF attachments must be at most 10 MiB and contain embedded text. Remote PDF URLs, OCR, vector-diagram reconstruction, complex multi-column layouts, DOCX, and PPTX are unsupported.

## Next steps

- [Install the CLI](../installation/) and [run a library in a few minutes](../quick-start/).
- Learn how the pieces fit together in [Architecture](../../concepts/architecture/).
