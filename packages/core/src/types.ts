import { z } from "zod";

export const sourceTypeSchema = z.enum(["blog", "x_thread"]);
export const readingStatusSchema = z.enum(["inbox", "reading", "read", "archived"]);
export const ingestionStateSchema = z.enum([
  "extracting",
  "awaiting_source",
  "awaiting_enrichment",
  "ready",
  "failed",
]);

export const citationSchema = z.object({
  url: z.url(),
  label: z.string().min(1).max(240),
});

export const itemFrontmatterSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.uuid(),
  originalUrl: z.url(),
  canonicalUrl: z.url(),
  sourceType: sourceTypeSchema,
  title: z.string().min(1),
  author: z.string().optional(),
  publishedAt: z.iso.datetime().optional(),
  capturedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  reading: z.object({
    status: readingStatusSchema,
    progress: z.number().min(0).max(1),
    lastReadAt: z.iso.datetime().optional(),
  }),
  tags: z.array(z.string()),
  extraction: z.object({
    status: z.enum(["pending", "complete", "failed"]),
    method: z.enum(["readability", "public_extract", "agent_supplied"]).optional(),
    retrievedAt: z.iso.datetime().optional(),
    contentHash: z.string().optional(),
    error: z.string().optional(),
  }),
  enrichment: z.object({
    status: z.enum(["pending", "complete", "failed"]),
    recipe: z.string(),
    recipeHash: z.string().optional(),
    completedAt: z.iso.datetime().optional(),
    summary: z.string().optional(),
    keyPoints: z.array(z.string()).optional(),
    citations: z.array(citationSchema).optional(),
    error: z.string().optional(),
  }),
});

export type ItemFrontmatter = z.infer<typeof itemFrontmatterSchema>;
export type SourceType = z.infer<typeof sourceTypeSchema>;
export type ReadingStatus = z.infer<typeof readingStatusSchema>;
export type IngestionState = z.infer<typeof ingestionStateSchema>;
export type Citation = z.infer<typeof citationSchema>;

export interface ShelfItem extends ItemFrontmatter {
  filePath: string;
  sourceMarkdown: string;
  insightMarkdown: string;
  revision: string;
}

export interface Recipe {
  name: string;
  description: string;
  instructions: string;
  hash: string;
  filePath: string;
}

export interface ExtractedSource {
  sourceType: SourceType;
  title: string;
  author?: string;
  publishedAt?: string;
  markdown: string;
  method: "readability" | "public_extract";
}

export interface LibraryListQuery {
  query?: string | undefined;
  status?: ReadingStatus | undefined;
  sourceType?: SourceType | undefined;
  tag?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface ItemSummary {
  id: string;
  title: string;
  canonicalUrl: string;
  sourceType: SourceType;
  author?: string;
  capturedAt: string;
  updatedAt: string;
  status: ReadingStatus;
  progress: number;
  tags: string[];
  ingestionState: IngestionState;
  summary?: string;
}
