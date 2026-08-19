export type ReadingStatus = "inbox" | "reading" | "read" | "archived";
export type SourceType = "blog" | "x_thread";
export type IngestionState =
  "extracting" | "awaiting_source" | "awaiting_enrichment" | "ready" | "failed";

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

export interface ShelfItem {
  id: string;
  title: string;
  originalUrl: string;
  canonicalUrl: string;
  sourceType: SourceType;
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
    citations?: { url: string; label: string }[];
    error?: string;
  };
  sourceMarkdown: string;
  insightMarkdown: string;
  revision: string;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
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
  void fetch(`/api/items/${item.id}/reading`, {
    method: "PATCH",
    keepalive: true,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status, progress, revision: item.revision }),
  });
}
