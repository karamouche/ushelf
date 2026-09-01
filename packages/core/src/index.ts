export { ShelfService } from "./application/shelf-service.js";
export type { IngestResult } from "./application/shelf-service.js";
export { resolveConfig } from "./configuration/ushelf-config.js";
export type { UshelfConfig } from "./configuration/ushelf-config.js";
export {
  citationSchema,
  ingestionStateSchema,
  itemFrontmatterSchema,
  mediaCaptureSchema,
  mediaCaptureStatsSchema,
  readingStatusSchema,
  sourceFileSchema,
  sourceTypeSchema,
} from "./domain/library-item.js";
export type {
  Citation,
  IngestionState,
  ItemFrontmatter,
  ItemSummary,
  LibraryListQuery,
  MediaCapture,
  MediaCaptureStats,
  ReadingStatus,
  ShelfItem,
  SourceFile,
  SourceType,
} from "./domain/library-item.js";
export type { Recipe } from "./domain/recipe.js";
