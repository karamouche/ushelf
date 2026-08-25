import type { IngestionState, ShelfItem } from "./library-item.js";

export function ingestionState(item: ShelfItem): IngestionState {
  if (item.extraction.status === "failed" || item.enrichment.status === "failed") return "failed";
  if (item.extraction.status === "pending") return "awaiting_source";
  if (item.enrichment.status === "pending") return "awaiting_enrichment";
  return "ready";
}
