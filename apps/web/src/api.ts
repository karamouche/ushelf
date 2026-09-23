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

export interface KindleStatus {
  configured: boolean;
  accountName?: string;
  homeRegion?: string;
  error?: { code: string; message: string };
}

export interface KindleDevice {
  name: string;
  serial: string;
}

export interface KindleDevices {
  devices: KindleDevice[];
  preferredTargetSerial?: string;
}

export interface KindleDeliveryResult {
  sku: string;
  itemId: string;
  revision: string;
  targetSerial: string;
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

export interface Account {
  id: string;
  email: string;
  name: string;
}

export async function setupStatus(): Promise<{ claimed: boolean }> {
  return request("/api/setup/status");
}

export async function resetOwnerPassword(code: string, password: string): Promise<void> {
  await request("/api/recovery/reset", {
    method: "POST",
    body: JSON.stringify({ code, password }),
  });
}

export async function claimOwner(input: {
  code: string;
  email: string;
  password: string;
  name?: string;
}): Promise<void> {
  await request("/api/setup/claim", { method: "POST", body: JSON.stringify(input) });
}

export async function signIn(email: string, password: string): Promise<void> {
  await request("/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export async function signOut(): Promise<void> {
  await request("/api/auth/sign-out", { method: "POST", body: "{}" });
}

export async function getAccount(): Promise<Account> {
  return (await request<{ user: Account }>("/api/account")).user;
}

export async function submitOAuthConsent(
  accept: boolean,
  oauthQuery: string,
): Promise<{ url?: string; redirect_uri?: string }> {
  return request("/api/auth/oauth2/consent", {
    method: "POST",
    body: JSON.stringify({ accept, oauth_query: oauthQuery }),
  });
}

export async function inspectDeviceCode(userCode: string): Promise<{
  user_code: string;
  status: string;
  client_id?: string;
  scope?: string;
}> {
  return request(`/api/auth/device?user_code=${encodeURIComponent(userCode)}`);
}

export async function decideDeviceCode(userCode: string, accept: boolean): Promise<void> {
  await request(`/api/auth/device/${accept ? "approve" : "deny"}`, {
    method: "POST",
    body: JSON.stringify({ userCode }),
  });
}

export async function listOAuthConsents(): Promise<unknown[]> {
  const result = await request<{ consents?: unknown[] }>("/api/auth/oauth2/get-consents");
  return result.consents ?? (Array.isArray(result) ? result : []);
}

export async function revokeOAuthConsent(id: string): Promise<void> {
  await request("/api/auth/oauth2/delete-consent", {
    method: "POST",
    body: JSON.stringify({ id }),
  });
}

export function mcpUrl(): string {
  return `${window.location.origin}${apiUrl("/mcp")}`;
}

export async function getKindleStatus(): Promise<KindleStatus> {
  return request<KindleStatus>("/api/kindle/status");
}

export async function listKindleDevices(): Promise<KindleDevices> {
  return request<KindleDevices>("/api/kindle/devices");
}

export async function sendToKindle(
  itemId: string,
  targetSerial: string,
): Promise<KindleDeliveryResult> {
  return request<KindleDeliveryResult>(`/api/items/${itemId}/kindle-deliveries`, {
    method: "POST",
    body: JSON.stringify({ targetSerial }),
  });
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
  options?: { keepalive?: boolean },
): Promise<ShelfItem> {
  return (
    await request<{ item: ShelfItem }>(`/api/items/${item.id}/reading`, {
      method: "PATCH",
      ...(options?.keepalive === undefined ? {} : { keepalive: options.keepalive }),
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
