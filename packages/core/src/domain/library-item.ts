import { z } from "zod";

export const sourceTypeSchema = z.enum(["article", "document", "x"]);
export const readingStatusSchema = z.enum(["inbox", "reading", "read", "archived"]);
export const ingestionStateSchema = z.enum([
  "extracting",
  "awaiting_source",
  "awaiting_enrichment",
  "ready",
  "failed",
]);

export const urlCitationSchema = z.object({
  url: z.url(),
  label: z.string().min(1).max(240),
});
export const pageCitationSchema = z.object({
  page: z.number().int().positive(),
  label: z.string().min(1).max(240),
});
export const citationSchema = z.union([urlCitationSchema, pageCitationSchema]);

export const sourceFileSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[^/\\\u0000-\u001f\u007f]+$/, "File name contains unsafe characters"),
  mediaType: z.literal("application/pdf"),
  sizeBytes: z
    .number()
    .int()
    .positive()
    .max(10 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  pageCount: z.number().int().positive().max(500),
});

const readingSchema = z.object({
  status: readingStatusSchema,
  progress: z.number().min(0).max(1),
  lastReadAt: z.iso.datetime().optional(),
});

const extractionSchema = z.object({
  status: z.enum(["pending", "complete", "failed"]),
  method: z.enum(["readability", "public_extract", "agent_supplied", "pdf_text"]).optional(),
  retrievedAt: z.iso.datetime().optional(),
  contentHash: z.string().optional(),
  error: z.string().optional(),
});

const enrichmentSchema = z.object({
  status: z.enum(["pending", "complete", "failed"]),
  recipe: z.string(),
  recipeHash: z.string().optional(),
  completedAt: z.iso.datetime().optional(),
  summary: z.string().optional(),
  keyPoints: z.array(z.string()).optional(),
  citations: z.array(citationSchema).optional(),
  error: z.string().optional(),
});

const commonFields = {
  schemaVersion: z.literal(1),
  id: z.uuid(),
  title: z.string().min(1),
  author: z.string().optional(),
  publishedAt: z.iso.datetime().optional(),
  capturedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  reading: readingSchema,
  tags: z.array(z.string()),
  extraction: extractionSchema,
  enrichment: enrichmentSchema,
};

const urlFrontmatterSchema = z.object({
  ...commonFields,
  sourceType: z.enum(["article", "x"]),
  originalUrl: z.url(),
  canonicalUrl: z.url(),
});

const documentFrontmatterSchema = z.object({
  ...commonFields,
  sourceType: z.literal("document"),
  file: sourceFileSchema,
});

export const itemFrontmatterSchema = z.union([urlFrontmatterSchema, documentFrontmatterSchema]);

export type ItemFrontmatter = z.infer<typeof itemFrontmatterSchema>;
export type SourceType = z.infer<typeof sourceTypeSchema>;
export type SourceFile = z.infer<typeof sourceFileSchema>;
export type ReadingStatus = z.infer<typeof readingStatusSchema>;
export type IngestionState = z.infer<typeof ingestionStateSchema>;
export type Citation = z.infer<typeof citationSchema>;

export type ShelfItem = ItemFrontmatter & {
  filePath: string;
  sourceMarkdown: string;
  insightMarkdown: string;
  revision: string;
};

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
  canonicalUrl?: string;
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
