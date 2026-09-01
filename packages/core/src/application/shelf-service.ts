import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { UshelfConfig } from "../configuration/ushelf-config.js";
import { resolveConfig } from "../configuration/ushelf-config.js";
import { ingestionState } from "../domain/ingestion-state.js";
import type {
  Citation,
  IngestionState,
  ItemFrontmatter,
  LibraryListQuery,
  MediaCaptureStats,
  ReadingStatus,
  ShelfItem,
} from "../domain/library-item.js";
import type { Recipe } from "../domain/recipe.js";
import { AwaitingSourceError, extractUrl } from "../ingestion/source-extractor.js";
import { decodePdfPayload, extractPdf } from "../ingestion/pdf-extractor.js";
import {
  assertLocalMarkdownImages,
  localizeMarkdownImages,
  mediaPath,
  mediaTypeForFilename,
  type MediaAsset,
  validateImage,
} from "../ingestion/media-localizer.js";
import {
  KindleError,
  type KindleDeliveryResult,
  type KindleDevice,
  type KindleStatus,
} from "../domain/kindle.js";
import { exportKindleEpub } from "../kindle/epub-exporter.js";
import { KindleBridgeGateway, type KindleGateway } from "../kindle/kindle-bridge.js";
import { canonicalizeUrl, detectSourceType } from "../ingestion/source-url.js";
import { sha256 } from "../persistence/markdown/item-markdown.js";
import { MarkdownRepository } from "../persistence/markdown/markdown-repository.js";
import { ShelfDatabase } from "../persistence/sqlite/shelf-database.js";

export interface IngestResult {
  item: ShelfItem;
  duplicate: boolean;
  state: IngestionState;
}

export interface ShelfServiceDependencies {
  kindleGateway?: KindleGateway;
}

export class ShelfService {
  private readonly config: UshelfConfig;
  private readonly repository: MarkdownRepository;
  private readonly database: ShelfDatabase;
  private readonly kindleGateway: KindleGateway;
  private readonly kindleDeliveries = new Set<string>();

  constructor(config = resolveConfig(), dependencies: ShelfServiceDependencies = {}) {
    this.config = config;
    this.repository = new MarkdownRepository(config);
    this.database = new ShelfDatabase(config.databasePath, config.itemsDir);
    this.kindleGateway = dependencies.kindleGateway ?? new KindleBridgeGateway(config);
  }

  async initialize(): Promise<void> {
    await this.repository.initialize();
    await this.reconcileIndex();
  }

  async rebuildIndex(): Promise<number> {
    this.database.clearIndex();
    return this.reconcileIndex();
  }

  private async reconcileIndex(): Promise<number> {
    const files = await this.repository.itemFiles();
    const found = new Set<string>();
    for (const filePath of files) {
      const item = await this.repository.load(filePath);
      found.add(item.id);
      this.database.upsert(item);
    }
    for (const id of this.database.indexedIds()) if (!found.has(id)) this.database.delete(id);
    return files.length;
  }

  async ingestUrl(url: string, recipeName = "default"): Promise<IngestResult> {
    const canonicalUrl = canonicalizeUrl(url);
    const existingId = this.database.findByCanonicalUrl(canonicalUrl);
    if (existingId) {
      const item = await this.getItem(existingId);
      return { item, duplicate: true, state: ingestionState(item) };
    }
    await this.repository.recipe(recipeName);
    const now = new Date().toISOString();
    const id = randomUUID();
    let sourceMarkdown = "";
    let sourceMedia = emptyMediaStats();
    let mediaAssets: MediaAsset[] = [];
    let title = new URL(canonicalUrl).hostname;
    let author: string | undefined;
    let extraction: ItemFrontmatter["extraction"] = { status: "pending" };
    try {
      const source = await extractUrl(canonicalUrl);
      const localized = await localizeMarkdownImages(source.markdown, id);
      sourceMarkdown = localized.markdown;
      sourceMedia = localized.stats;
      mediaAssets = localized.assets;
      title = source.title;
      author = source.author;
      extraction = {
        status: "complete",
        method: source.method,
        retrievedAt: now,
        contentHash: sha256(sourceMarkdown),
      };
    } catch (error) {
      if (error instanceof AwaitingSourceError || detectSourceType(canonicalUrl) === "x")
        extraction = {
          status: "pending",
          error: error instanceof Error ? error.message : String(error),
        };
      else
        extraction = {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        };
    }
    const frontmatter: ItemFrontmatter = {
      id,
      originalUrl: url,
      canonicalUrl,
      sourceType: detectSourceType(canonicalUrl),
      title,
      ...(author ? { author } : {}),
      capturedAt: now,
      updatedAt: now,
      reading: { status: "inbox", progress: 0 },
      tags: [],
      extraction,
      enrichment: { status: "pending", recipe: recipeName },
      media: { source: sourceMedia, insights: emptyMediaStats() },
    };
    let item: ShelfItem;
    try {
      await this.repository.saveMediaAssets(id, mediaAssets);
      item = await this.repository.save(frontmatter, "", sourceMarkdown);
    } catch (error) {
      await this.repository.removeItemFiles(id);
      throw error;
    }
    this.database.upsert(item);
    return { item, duplicate: false, state: ingestionState(item) };
  }

  async ingestFile(input: {
    filename: string;
    contentBase64: string;
    recipe?: string | undefined;
  }): Promise<IngestResult> {
    const bytes = decodePdfPayload(input.filename, input.contentBase64);
    const sourceHash = createHash("sha256").update(bytes).digest("hex");
    const existingId = this.database.findBySourceHash(sourceHash);
    if (existingId) {
      const item = await this.getItem(existingId);
      return { item, duplicate: true, state: ingestionState(item) };
    }
    const recipeName = input.recipe ?? "default";
    await this.repository.recipe(recipeName);
    const now = new Date().toISOString();
    const id = randomUUID();
    const source = await extractPdf(bytes, input.filename, id);
    const frontmatter: ItemFrontmatter = {
      id,
      sourceType: "document",
      file: {
        name: input.filename,
        mediaType: "application/pdf",
        sizeBytes: bytes.length,
        sha256: sourceHash,
        pageCount: source.pageCount,
      },
      title: source.title,
      ...(source.author ? { author: source.author } : {}),
      capturedAt: now,
      updatedAt: now,
      reading: { status: "inbox", progress: 0 },
      tags: [],
      extraction: {
        status: "complete",
        method: "pdf_text",
        retrievedAt: now,
        contentHash: sha256(source.markdown),
      },
      enrichment: { status: "pending", recipe: recipeName },
      media: { source: source.media, insights: emptyMediaStats() },
    };
    let item: ShelfItem;
    try {
      await this.repository.saveOriginalFile(id, bytes);
      await this.repository.saveMediaAssets(id, source.assets);
      item = await this.repository.save(frontmatter, "", source.markdown);
    } catch (error) {
      await this.repository.removeItemFiles(id);
      throw error;
    }
    this.database.upsert(item);
    return { item, duplicate: false, state: ingestionState(item) };
  }

  async submitSourceContent(input: {
    itemId: string;
    title: string;
    markdown: string;
    author?: string | undefined;
    publishedAt?: string | undefined;
    revision?: string | undefined;
  }): Promise<ShelfItem> {
    const item = await this.getItem(input.itemId);
    assertRevision(item, input.revision);
    if (item.sourceType !== "x")
      throw new Error("Agent-supplied source fallback is only enabled for X sources");
    if (input.markdown.trim().length < 40) throw new Error("Submitted source content is too short");
    const localized = await localizeMarkdownImages(input.markdown, item.id, (filename) =>
      this.mediaExists(item.id, filename),
    );
    const latest = await this.getItem(input.itemId);
    assertRevision(latest, input.revision);
    const sourceChanged = latest.extraction.contentHash !== sha256(localized.markdown);
    if (sourceChanged && latest.enrichment.status === "complete")
      await this.repository.archive(latest);
    const now = new Date().toISOString();
    const frontmatter: ItemFrontmatter = {
      ...frontmatterOf(latest),
      title: input.title.trim(),
      ...(input.author ? { author: input.author.trim() } : {}),
      ...(input.publishedAt ? { publishedAt: input.publishedAt } : {}),
      updatedAt: now,
      extraction: {
        status: "complete",
        method: "agent_supplied",
        retrievedAt: now,
        contentHash: sha256(localized.markdown),
      },
      ...(sourceChanged
        ? { enrichment: { status: "pending" as const, recipe: latest.enrichment.recipe } }
        : {}),
      media: {
        source: localized.stats,
        insights: sourceChanged ? emptyMediaStats() : latest.media.insights,
      },
    };
    await this.repository.saveMediaAssets(item.id, localized.assets);
    const saved = await this.repository.save(
      frontmatter,
      sourceChanged ? "" : latest.insightMarkdown,
      localized.markdown,
      latest.filePath,
    );
    this.database.upsert(saved);
    return saved;
  }

  async ingestionContext(id: string): Promise<{
    item: ShelfItem;
    recipe: Awaited<ReturnType<MarkdownRepository["recipe"]>>;
    outputContract: object;
  }> {
    const item = await this.getItem(id);
    if (item.extraction.status !== "complete")
      throw new Error("Source content must be complete before enrichment");
    const recipe = await this.repository.recipe(item.enrichment.recipe);
    return {
      item,
      recipe,
      outputContract: {
        summary: "string (1-1200 characters)",
        keyPoints: "string[] (1-12)",
        tags: "lowercase string[] (0-12)",
        citations:
          item.sourceType === "document"
            ? "{page,label}[] using page numbers present in the document"
            : "{url,label}[] using URLs present in the source or the original URL",
        bodyMarkdown: "recipe-specific Markdown",
      },
    };
  }

  async saveInsights(input: {
    itemId: string;
    recipeHash: string;
    revision: string;
    summary: string;
    keyPoints: string[];
    tags: string[];
    citations: Citation[];
    bodyMarkdown: string;
  }): Promise<ShelfItem> {
    const item = await this.getItem(input.itemId);
    assertRevision(item, input.revision);
    const recipe = await this.repository.recipe(item.enrichment.recipe);
    if (recipe.hash !== input.recipeHash)
      throw new Error("The recipe changed; fetch a new ingestion context before saving");
    validateCitations(item, input.citations);
    const localized = await localizeMarkdownImages(input.bodyMarkdown, item.id, (filename) =>
      this.mediaExists(item.id, filename),
    );
    const latest = await this.getItem(input.itemId);
    assertRevision(latest, input.revision);
    if ((await this.repository.recipe(latest.enrichment.recipe)).hash !== input.recipeHash)
      throw new Error("The recipe changed; fetch a new ingestion context before saving");
    if (item.enrichment.status === "complete") await this.repository.archive(item);
    const now = new Date().toISOString();
    const frontmatter: ItemFrontmatter = {
      ...frontmatterOf(item),
      updatedAt: now,
      tags: [...new Set(input.tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))].slice(
        0,
        12,
      ),
      enrichment: {
        status: "complete",
        recipe: recipe.name,
        recipeHash: recipe.hash,
        completedAt: now,
        summary: input.summary.trim(),
        keyPoints: input.keyPoints
          .map((point) => point.trim())
          .filter(Boolean)
          .slice(0, 12),
        citations: input.citations,
      },
      media: { ...item.media, insights: localized.stats },
    };
    await this.repository.saveMediaAssets(item.id, localized.assets);
    const saved = await this.repository.save(
      frontmatter,
      localized.markdown,
      item.sourceMarkdown,
      item.filePath,
    );
    this.database.upsert(saved);
    return saved;
  }

  async getItem(id: string): Promise<ShelfItem> {
    const location = this.database.itemLocation(id);
    const item = await this.repository.loadById(id, location?.filePath);
    if (!location?.portable || location.filePath !== item.filePath) this.database.upsert(item);
    return item;
  }

  async getOriginalFile(id: string): Promise<{
    bytes: Buffer;
    name: string;
    mediaType: "application/pdf";
  }> {
    const item = await this.getItem(id);
    if (item.sourceType !== "document") throw new Error("Item does not have an original file");
    try {
      return {
        bytes: await this.repository.originalFile(id),
        name: item.file.name,
        mediaType: item.file.mediaType,
      };
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        throw new Error("Original file was not found");
      }
      throw error;
    }
  }

  async getMediaFile(
    id: string,
    filename: string,
  ): Promise<{
    bytes: Buffer;
    mediaType: string;
  }> {
    await this.getItem(id);
    try {
      return {
        bytes: await this.repository.mediaFile(id, filename),
        mediaType: mediaTypeForFilename(filename),
      };
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        throw new Error("Media file was not found");
      }
      throw error;
    }
  }

  async kindleStatus(signal?: AbortSignal): Promise<KindleStatus> {
    try {
      const status = await this.kindleGateway.status(signal);
      return {
        configured: true,
        ...(status.accountName ? { accountName: status.accountName } : {}),
        ...(status.homeRegion ? { homeRegion: status.homeRegion } : {}),
      };
    } catch (error) {
      if (error instanceof KindleError && error.code === "not_configured") {
        return { configured: false };
      }
      if (error instanceof KindleError) {
        return {
          configured: true,
          error: { code: error.code, message: error.message },
        };
      }
      throw error;
    }
  }

  async kindleDevices(signal?: AbortSignal): Promise<KindleDevice[]> {
    return this.kindleGateway.devices(signal);
  }

  async sendToKindle(
    id: string,
    targetSerial: string,
    signal?: AbortSignal,
  ): Promise<KindleDeliveryResult> {
    const item = await this.getItem(id);
    if (item.extraction.status !== "complete" || !item.sourceMarkdown.trim()) {
      throw new KindleError(
        "source_unavailable",
        "This item does not have completed source content to send.",
      );
    }
    const deliveryKey = `${item.id}\0${targetSerial}`;
    if (this.kindleDeliveries.has(deliveryKey)) {
      throw new KindleError(
        "delivery_in_progress",
        "A Kindle delivery for this item and device is already in progress.",
      );
    }
    this.kindleDeliveries.add(deliveryKey);
    try {
      const devices = await this.kindleGateway.devices(signal);
      if (!devices.some((device) => device.serial === targetSerial)) {
        throw new KindleError("device_not_found", "The selected Kindle device was not found.");
      }
      let bytes: Uint8Array;
      try {
        const filenames = [...new Set(assertLocalMarkdownImages(item.sourceMarkdown, item.id))];
        const media = await Promise.all(
          filenames.map(async (filename) => ({
            filename,
            mediaType: mediaTypeForFilename(filename),
            bytes: await this.repository.mediaFile(item.id, filename),
          })),
        );
        bytes = await exportKindleEpub(item, media);
      } catch (error) {
        if (error instanceof Error && /60 MiB export limit/.test(error.message)) {
          throw new KindleError(
            "export_too_large",
            "This item is larger than the 60 MiB Kindle export limit.",
          );
        }
        throw new KindleError(
          "export_failed",
          "The Kindle EPUB could not be prepared because its source or saved images are unavailable.",
        );
      }
      const sku = await this.kindleGateway.send(
        {
          bytes,
          title: item.title,
          ...(item.author ? { author: item.author } : {}),
          targetSerial,
        },
        signal,
      );
      return { sku, itemId: item.id, revision: item.revision, targetSerial };
    } finally {
      this.kindleDeliveries.delete(deliveryKey);
    }
  }

  private async mediaExists(id: string, filename: string): Promise<boolean> {
    try {
      await this.repository.mediaFile(id, filename);
      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
      throw error;
    }
  }

  listItems(query: LibraryListQuery = {}) {
    return this.database.list(query);
  }

  async listRecipes(): Promise<Recipe[]> {
    return this.repository.recipes();
  }

  async getRecipe(name: string): Promise<Recipe> {
    return this.repository.recipe(name);
  }

  async updateReading(
    id: string,
    status: ReadingStatus,
    progress: number,
    revision?: string,
  ): Promise<ShelfItem> {
    const item = await this.getItem(id);
    assertRevision(item, revision);
    const now = new Date().toISOString();
    const normalizedProgress = Math.max(0, Math.min(1, progress));
    const saved = await this.repository.save(
      {
        ...frontmatterOf(item),
        updatedAt: now,
        reading: { status, progress: status === "read" ? 1 : normalizedProgress, lastReadAt: now },
      },
      item.insightMarkdown,
      item.sourceMarkdown,
      item.filePath,
    );
    this.database.upsert(saved);
    return saved;
  }

  async markForReenrichment(id: string): Promise<ShelfItem> {
    const item = await this.getItem(id);
    if (item.enrichment.status === "complete") await this.repository.archive(item);
    const saved = await this.repository.save(
      {
        ...frontmatterOf(item),
        updatedAt: new Date().toISOString(),
        enrichment: { status: "pending", recipe: item.enrichment.recipe },
        media: { ...item.media, insights: emptyMediaStats() },
      },
      "",
      item.sourceMarkdown,
      item.filePath,
    );
    this.database.upsert(saved);
    return saved;
  }

  async refreshSource(id: string, revision?: string): Promise<ShelfItem> {
    const item = await this.getItem(id);
    assertRevision(item, revision);
    if (item.sourceType === "document") {
      throw new Error("Document sources cannot be refreshed; ingest the PDF again instead");
    }
    const source = await extractUrl(item.canonicalUrl);
    const localized = await localizeMarkdownImages(source.markdown, item.id);
    const latest = await this.getItem(id);
    assertRevision(latest, revision);
    const contentHash = sha256(localized.markdown);
    const changed = latest.extraction.contentHash !== contentHash;
    if (changed && latest.enrichment.status === "complete") await this.repository.archive(latest);
    const now = new Date().toISOString();
    await this.repository.saveMediaAssets(item.id, localized.assets);
    const saved = await this.repository.save(
      {
        ...frontmatterOf(latest),
        title: source.title,
        ...(source.author ? { author: source.author } : {}),
        updatedAt: now,
        extraction: { status: "complete", method: source.method, retrievedAt: now, contentHash },
        ...(changed
          ? { enrichment: { status: "pending" as const, recipe: latest.enrichment.recipe } }
          : {}),
        media: {
          source: localized.stats,
          insights: changed ? emptyMediaStats() : latest.media.insights,
        },
      },
      changed ? "" : latest.insightMarkdown,
      localized.markdown,
      latest.filePath,
    );
    this.database.upsert(saved);
    return saved;
  }

  async staleItems() {
    const summaries = this.database.list({ limit: 200 });
    const stale = [];
    for (const summary of summaries) {
      const item = await this.getItem(summary.id);
      const recipe = await this.repository.recipe(item.enrichment.recipe);
      if (item.enrichment.status === "complete" && item.enrichment.recipeHash !== recipe.hash)
        stale.push(summary);
    }
    return stale;
  }

  requestDelete(id: string): { token: string; expiresAt: string } {
    if (!this.database.hasItem(id)) throw new Error(`Item ${id} was not found`);
    const token = randomBytes(24).toString("base64url");
    const expiresAt = Date.now() + 5 * 60_000;
    this.database.createDeleteToken(token, id, expiresAt);
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  async confirmDelete(id: string, token: string): Promise<void> {
    if (!this.database.consumeDeleteToken(token, id))
      throw new Error("Delete confirmation is invalid or expired");
    const item = await this.getItem(id);
    await this.repository.remove(item);
    this.database.delete(id);
  }

  async importMarkdown(sourcePath: string): Promise<ShelfItem> {
    const resolvedPath = path.resolve(sourcePath);
    const imported = await this.repository.load(resolvedPath);
    const duplicate =
      imported.sourceType === "document"
        ? this.database.findBySourceHash(imported.file.sha256)
        : this.database.findByCanonicalUrl(imported.canonicalUrl);
    if (duplicate) throw new Error("An item with this canonical URL already exists");
    const filenames = [
      ...assertLocalMarkdownImages(imported.sourceMarkdown, imported.id),
      ...assertLocalMarkdownImages(imported.insightMarkdown, imported.id),
    ];
    const assets = await Promise.all(
      [...new Set(filenames)].map(async (filename) => {
        const sourceAsset = path.resolve(
          path.dirname(resolvedPath),
          mediaPath(imported.id, filename),
        );
        const bytes = await readFile(sourceAsset);
        const validated = validateImage(bytes, mediaTypeForFilename(filename));
        if (validated.extension !== filename.slice(filename.lastIndexOf(".") + 1))
          throw new Error(`Imported media type does not match its filename: ${filename}`);
        const expectedHash = filename.slice(0, 64);
        if (createHash("sha256").update(validated.bytes).digest("hex") !== expectedHash)
          throw new Error(`Imported media hash does not match its filename: ${filename}`);
        return { filename, mediaType: validated.mediaType, bytes: validated.bytes };
      }),
    );
    await this.repository.saveMediaAssets(imported.id, assets);
    const item = await this.repository.importFile(resolvedPath);
    this.database.upsert(item);
    return item;
  }
}

function emptyMediaStats(): MediaCaptureStats {
  return { discovered: 0, localized: 0, omitted: 0, filtered: 0 };
}

function frontmatterOf(item: ShelfItem): ItemFrontmatter {
  const {
    filePath: _filePath,
    sourceMarkdown: _source,
    insightMarkdown: _insights,
    revision: _revision,
    ...frontmatter
  } = item;
  return frontmatter;
}

function assertRevision(item: ShelfItem, revision?: string): void {
  if (revision && revision !== item.revision)
    throw new Error("Item changed since it was read; fetch it again before writing");
}

function validateCitations(item: ShelfItem, citations: Citation[]): void {
  if (item.sourceType === "document") {
    for (const citation of citations) {
      if (!("page" in citation)) throw new Error("Document citations must use page numbers");
      if (citation.page > item.file.pageCount) {
        throw new Error(`Citation page is outside the document: ${citation.page}`);
      }
    }
    return;
  }
  const available = new Set<string>([item.originalUrl, item.canonicalUrl]);
  for (const match of item.sourceMarkdown.matchAll(/https?:\/\/[^\s)\]>]+/g))
    available.add(match[0].replace(/[.,;:]$/, ""));
  for (const citation of citations) {
    if (!("url" in citation)) throw new Error("URL sources must use URL citations");
    if (!available.has(citation.url))
      throw new Error(`Citation URL is not present in the source: ${citation.url}`);
  }
}
