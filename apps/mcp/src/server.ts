import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ShelfService, citationSchema, readingStatusSchema, sourceTypeSchema } from "@ushelf/core";
import { z } from "zod";
import { registerKindleTools } from "./kindle-tools.js";

const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: value as Record<string, unknown>,
});

export const USHELF_MCP_INSTRUCTIONS =
  "uShelf is the owner's personal read-later library. Ingest sources deterministically, then use get_ingestion_context and save_insights for source-grounded enrichment. Read operations are safe. Refresh and re-enrichment replace derived insights. Permanent deletion always requires request_delete followed by confirm_delete with the returned short-lived token.";

export function createUshelfMcpServer(service: ShelfService): McpServer {
  const server = new McpServer(
    { name: "ushelf", version: process.env.USHELF_VERSION ?? "0.1.0" },
    { instructions: USHELF_MCP_INSTRUCTIONS },
  );

  registerKindleTools(server, service);

  server.registerTool(
    "ingest_url",
    {
      title: "Ingest URL",
      description: "Create or return a library item and deterministically extract its source.",
      inputSchema: { url: z.url(), recipe: z.string().default("default") },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ url, recipe }) => json(await service.ingestUrl(url, recipe)),
  );

  server.registerTool(
    "ingest_file",
    {
      title: "Ingest PDF",
      description: "Create or return a document by deterministically extracting an attached PDF.",
      inputSchema: {
        filename: z.string().min(1).max(255),
        contentBase64: z
          .string()
          .min(4)
          .max(Math.ceil((10 * 1024 * 1024) / 3) * 4),
        recipe: z.string().default("default"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => json(await service.ingestFile(input)),
  );

  server.registerTool(
    "get_ingestion",
    {
      title: "Get ingestion",
      description: "Inspect an item's current ingestion stage.",
      inputSchema: { itemId: z.uuid() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ itemId }) => json(await service.getItem(itemId)),
  );

  server.registerTool(
    "submit_source_content",
    {
      title: "Submit X source",
      description: "Supply X source Markdown when public extraction is blocked.",
      inputSchema: {
        itemId: z.uuid(),
        title: z.string().min(1),
        markdown: z.string().min(40),
        author: z.string().optional(),
        publishedAt: z.iso.datetime().optional(),
        revision: z.string().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => json(await service.submitSourceContent(input)),
  );

  server.registerTool(
    "get_ingestion_context",
    {
      title: "Get enrichment context",
      description: "Return source, recipe instructions, hash, revision, and output contract.",
      inputSchema: { itemId: z.uuid() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ itemId }) => json(await service.ingestionContext(itemId)),
  );

  server.registerTool(
    "save_insights",
    {
      title: "Save insights",
      description: "Validate and atomically save source-grounded agent insights.",
      inputSchema: {
        itemId: z.uuid(),
        recipeHash: z.string().length(64),
        revision: z.string().length(64),
        summary: z.string().min(1).max(1200),
        keyPoints: z.array(z.string().min(1)).min(1).max(12),
        tags: z.array(z.string()).max(12),
        citations: z.array(citationSchema),
        bodyMarkdown: z.string(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => json(await service.saveInsights(input)),
  );

  server.registerTool(
    "list_items",
    {
      title: "List library",
      description: "List items with optional reading and source filters.",
      inputSchema: {
        status: readingStatusSchema.optional(),
        sourceType: sourceTypeSchema.optional(),
        tag: z.string().optional(),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) => json({ items: service.listItems(input) }),
  );

  server.registerTool(
    "search_items",
    {
      title: "Search library",
      description: "Full-text search across source text, insights, titles, and tags.",
      inputSchema: {
        query: z.string().min(1),
        status: readingStatusSchema.optional(),
        sourceType: sourceTypeSchema.optional(),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) => json({ items: service.listItems(input) }),
  );

  server.registerTool(
    "get_item",
    {
      title: "Get item",
      description: "Read one complete library item.",
      inputSchema: { itemId: z.uuid() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ itemId }) => json(await service.getItem(itemId)),
  );

  server.registerTool(
    "update_reading_state",
    {
      title: "Update reading state",
      description: "Set status and progress with optional optimistic concurrency.",
      inputSchema: {
        itemId: z.uuid(),
        status: readingStatusSchema,
        progress: z.number().min(0).max(1),
        revision: z.string().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ itemId, status, progress, revision }) =>
      json(await service.updateReading(itemId, status, progress, revision)),
  );

  server.registerTool(
    "list_stale_items",
    {
      title: "List stale enrichments",
      description: "Find items produced by an older version of their recipe.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => json({ items: await service.staleItems() }),
  );

  server.registerTool(
    "refresh_source",
    {
      title: "Refresh source",
      description:
        "Re-fetch a source; changed content archives insights and returns to enrichment pending.",
      inputSchema: { itemId: z.uuid(), revision: z.string().optional() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ itemId, revision }) => json(await service.refreshSource(itemId, revision)),
  );

  server.registerTool(
    "request_reenrichment",
    {
      title: "Request re-enrichment",
      description:
        "Archive current insights and mark an item pending without changing source content.",
      inputSchema: { itemId: z.uuid() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ itemId }) => json(await service.markForReenrichment(itemId)),
  );

  server.registerTool(
    "request_delete",
    {
      title: "Request deletion",
      description: "Issue a short-lived confirmation token; this does not delete anything.",
      inputSchema: { itemId: z.uuid() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ itemId }) => json(service.requestDelete(itemId)),
  );

  server.registerTool(
    "confirm_delete",
    {
      title: "Confirm deletion",
      description: "Permanently delete an item using its confirmation token.",
      inputSchema: { itemId: z.uuid(), token: z.string().min(20) },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ itemId, token }) => {
      await service.confirmDelete(itemId, token);
      return json({ deleted: true, itemId });
    },
  );

  server.registerResource(
    "item-source",
    new ResourceTemplate("ushelf://items/{id}/source", { list: undefined }),
    {
      title: "uShelf item source",
      description: "Normalized source Markdown for a library item",
      mimeType: "text/markdown",
    },
    async (uri, variables) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: (await service.getItem(String(variables.id))).sourceMarkdown,
        },
      ],
    }),
  );

  server.registerResource(
    "item-document",
    new ResourceTemplate("ushelf://items/{id}/document", { list: undefined }),
    {
      title: "uShelf item",
      description: "Complete item metadata and Markdown sections",
      mimeType: "application/json",
    },
    async (uri, variables) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(await service.getItem(String(variables.id)), null, 2),
        },
      ],
    }),
  );

  server.registerResource(
    "recipe",
    new ResourceTemplate("ushelf://recipes/{name}", { list: undefined }),
    {
      title: "uShelf recipe",
      description: "Versioned agent enrichment instructions",
      mimeType: "text/markdown",
    },
    async (uri, variables) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: (await service.getRecipe(String(variables.name))).instructions,
        },
      ],
    }),
  );

  return server;
}
