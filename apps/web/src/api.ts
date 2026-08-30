import { resolveRuntimeBasePath } from "./runtime-base-path.js";

export type ReadingStatus = "inbox" | "reading" | "read" | "archived";
export type SourceType = "article" | "document" | "x";
export type Citation = { url: string; label: string } | { page: number; label: string };
export type IngestionState =
  "extracting" | "awaiting_source" | "awaiting_enrichment" | "ready" | "failed";

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

export interface ShelfItem {
  id: string;
  title: string;
  originalUrl?: string;
  canonicalUrl?: string;
  sourceType: SourceType;
  file?: {
    name: string;
    mediaType: "application/pdf";
    sizeBytes: number;
    sha256: string;
    pageCount: number;
  };
  author?: string;
  capturedAt: string;
  updatedAt: string;
  reading: { status: ReadingStatus; progress: number; lastReadAt?: string };
  tags: string[];
  extraction: { status: string; method?: string; error?: string };
  enrichment: {
    status: string;
    recipe: string;
    recipeHash?: string;
    summary?: string;
    keyPoints?: string[];
    citations?: Citation[];
    error?: string;
  };
  media: {
    source: MediaCaptureStats;
    insights: MediaCaptureStats;
  };
  sourceMarkdown: string;
  insightMarkdown: string;
  revision: string;
}

interface MediaCaptureStats {
  discovered: number;
  localized: number;
  omitted: number;
  filtered: number;
}

const BASE_PATH = resolveRuntimeBasePath().replace(/\/$/, "");

function apiUrl(path: string): string {
  return `${BASE_PATH}${path}`;
}

export function originalFileUrl(id: string, page?: number): string {
  return `${apiUrl(`/api/items/${id}/original`)}${page ? `#page=${page}` : ""}`;
}

export function localMediaUrl(id: string, source?: string): string | undefined {
  const prefix = `../../files/${id}/media/`;
  if (!source?.startsWith(prefix)) return undefined;
  const filename = source.slice(prefix.length);
  if (!/^[a-f0-9]{64}\.(?:png|jpg|gif|webp|avif|svg)$/.test(filename)) return undefined;
  return apiUrl(`/api/items/${encodeURIComponent(id)}/media/${filename}`);
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(path), {
    ...options,
    headers: { "content-type": "application/json", ...options?.headers },
  });
  const value = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(value.error ?? `Request failed (${response.status})`);
  return value;
}

export async function listItems(filters: {
  q?: string;
  status?: string;
  sourceType?: string;
}): Promise<ItemSummary[]> {
  const query = new URLSearchParams(
    Object.entries(filters).filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
  return (await request<{ items: ItemSummary[] }>(`/api/items?${query}`)).items;
}

export async function getItem(id: string): Promise<ShelfItem> {
  return (await request<{ item: ShelfItem }>(`/api/items/${id}`)).item;
}

export async function updateReading(
  item: ShelfItem,
  status: ReadingStatus,
  progress: number,
): Promise<ShelfItem> {
  return (
    await request<{ item: ShelfItem }>(`/api/items/${item.id}/reading`, {
      method: "PATCH",
      body: JSON.stringify({ status, progress, revision: item.revision }),
    })
  ).item;
}

export function updateReadingOnExit(
  item: ShelfItem,
  status: ReadingStatus,
  progress: number,
): void {
  void fetch(apiUrl(`/api/items/${item.id}/reading`), {
    method: "PATCH",
    keepalive: true,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status, progress, revision: item.revision }),
  });
}
