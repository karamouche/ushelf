export { ShelfService } from "./application/shelf-service.js";
export type { IngestResult } from "./application/shelf-service.js";
export { resolveConfig } from "./configuration/ushelf-config.js";
export type { UshelfConfig } from "./configuration/ushelf-config.js";
export {
  citationSchema,
  ingestionStateSchema,
  itemFrontmatterSchema,
  readingStatusSchema,
  sourceTypeSchema,
} from "./domain/library-item.js";
export type {
  Citation,
  IngestionState,
  ItemFrontmatter,
  ItemSummary,
  LibraryListQuery,
  ReadingStatus,
  ShelfItem,
  SourceType,
} from "./domain/library-item.js";
export type { Recipe } from "./domain/recipe.js";
