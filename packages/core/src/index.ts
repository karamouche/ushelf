export { ShelfService } from "./application/shelf-service.js";
export type { IngestResult, ShelfServiceDependencies } from "./application/shelf-service.js";
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
export { KindleError, kindleTargetSchema } from "./domain/kindle.js";
export type { KindleDeliveryResult, KindleDevice, KindleStatus } from "./domain/kindle.js";
export type { KindleGateway } from "./kindle/kindle-bridge.js";
