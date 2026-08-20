import { randomBytes, randomUUID } from "node:crypto";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { UshelfConfig } from "./config.js";
import { resolveConfig } from "./config.js";
import { ShelfDatabase, ingestionState } from "./database.js";
import { AwaitingSourceError, extractUrl } from "./extraction.js";
import { sha256 } from "./markdown.js";
import { MarkdownRepository } from "./repository.js";
import { canonicalizeUrl, detectSourceType } from "./url.js";
import type {
  Citation,
  ItemFrontmatter,
  LibraryListQuery,
  ReadingStatus,
  ShelfItem,
} from "./types.js";

export interface IngestResult {
  item: ShelfItem;
  duplicate: boolean;
  state: string;
}

export class ShelfService {
  readonly config: UshelfConfig;
  readonly repository: MarkdownRepository;
  readonly database: ShelfDatabase;

  constructor(config = resolveConfig()) {
    this.config = config;
    this.repository = new MarkdownRepository(config);
    this.database = new ShelfDatabase(config.databasePath, config.itemsDir);
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
    let sourceMarkdown = "";
    let title = new URL(canonicalUrl).hostname;
    let author: string | undefined;
    let extraction: ItemFrontmatter["extraction"] = { status: "pending" };
    try {
      const source = await extractUrl(canonicalUrl);
      sourceMarkdown = source.markdown;
      title = source.title;
      author = source.author;
      extraction = {
        status: "complete",
        method: source.method,
        retrievedAt: now,
        contentHash: sha256(sourceMarkdown),
      };
    } catch (error) {
      if (error instanceof AwaitingSourceError || detectSourceType(canonicalUrl) === "x_thread")
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
      schemaVersion: 1,
      id: randomUUID(),
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
    };
    const item = await this.repository.save(frontmatter, "", sourceMarkdown);
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
    if (item.sourceType !== "x_thread")
      throw new Error("Agent-supplied source fallback is only enabled for X threads");
    if (input.markdown.trim().length < 40) throw new Error("Submitted source content is too short");
    const sourceChanged = item.extraction.contentHash !== sha256(input.markdown);
    if (sourceChanged && item.enrichment.status === "complete") await this.repository.archive(item);
    const now = new Date().toISOString();
    const frontmatter: ItemFrontmatter = {
      ...frontmatterOf(item),
      title: input.title.trim(),
      ...(input.author ? { author: input.author.trim() } : {}),
      ...(input.publishedAt ? { publishedAt: input.publishedAt } : {}),
      updatedAt: now,
      extraction: {
        status: "complete",
        method: "agent_supplied",
        retrievedAt: now,
        contentHash: sha256(input.markdown),
      },
      ...(sourceChanged
        ? { enrichment: { status: "pending" as const, recipe: item.enrichment.recipe } }
        : {}),
    };
    const saved = await this.repository.save(
      frontmatter,
      item.insightMarkdown,
      input.markdown,
      item.filePath,
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
        citations: "{url,label}[] using URLs present in the source or the original URL",
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
    };
    const saved = await this.repository.save(
      frontmatter,
      input.bodyMarkdown,
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

  listItems(query: LibraryListQuery = {}) {
    return this.database.list(query);
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
    const source = await extractUrl(item.canonicalUrl);
    const contentHash = sha256(source.markdown);
    const changed = item.extraction.contentHash !== contentHash;
    if (changed && item.enrichment.status === "complete") await this.repository.archive(item);
    const now = new Date().toISOString();
    const saved = await this.repository.save(
      {
        ...frontmatterOf(item),
        title: source.title,
        ...(source.author ? { author: source.author } : {}),
        updatedAt: now,
        extraction: { status: "complete", method: source.method, retrievedAt: now, contentHash },
        ...(changed
          ? { enrichment: { status: "pending" as const, recipe: item.enrichment.recipe } }
          : {}),
      },
      changed ? "" : item.insightMarkdown,
      source.markdown,
      item.filePath,
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
    const imported = await this.repository.load(path.resolve(sourcePath));
    if (this.database.findByCanonicalUrl(imported.canonicalUrl))
      throw new Error("An item with this canonical URL already exists");
    const copiedPath = path.join(
      this.config.itemsDir,
      imported.capturedAt.slice(0, 4),
      path.basename(imported.filePath),
    );
    await mkdir(path.dirname(copiedPath), { recursive: true });
    await copyFile(imported.filePath, copiedPath);
    const item = await this.repository.load(copiedPath);
    this.database.upsert(item);
    return item;
  }
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
  const available = new Set<string>([item.originalUrl, item.canonicalUrl]);
  for (const match of item.sourceMarkdown.matchAll(/https?:\/\/[^\s)\]>]+/g))
    available.add(match[0].replace(/[.,;:]$/, ""));
  for (const citation of citations) {
    if (!available.has(citation.url))
      throw new Error(`Citation URL is not present in the source: ${citation.url}`);
  }
}
