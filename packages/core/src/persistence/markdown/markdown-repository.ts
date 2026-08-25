import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { UshelfConfig } from "../../configuration/ushelf-config.js";
import type { ItemFrontmatter, ShelfItem } from "../../domain/library-item.js";
import type { Recipe } from "../../domain/recipe.js";
import { parseItemMarkdown, parseRecipe, renderItemMarkdown, sha256 } from "./item-markdown.js";

export class MarkdownRepository {
  constructor(readonly config: UshelfConfig) {}

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.config.itemsDir, { recursive: true }),
      mkdir(this.config.historyDir, { recursive: true }),
      mkdir(this.config.recipesDir, { recursive: true }),
      mkdir(this.config.stateDir, { recursive: true }),
    ]);
  }

  async load(filePath: string): Promise<ShelfItem> {
    return parseItemMarkdown(await readFile(filePath, "utf8"), filePath);
  }

  async loadById(id: string, indexedPath?: string): Promise<ShelfItem> {
    if (indexedPath) {
      try {
        const indexed = await this.load(indexedPath);
        if (indexed.id === id) return indexed;
      } catch (error) {
        if (!isMissingFileError(error)) throw error;
      }
    }
    for (const filePath of await this.itemFiles()) {
      const item = await this.load(filePath);
      if (item.id === id) return item;
    }
    throw new Error(`Item ${id} was not found`);
  }

  async importFile(sourcePath: string): Promise<ShelfItem> {
    const raw = await readFile(sourcePath, "utf8");
    const imported = parseItemMarkdown(raw, sourcePath);
    const destination = path.join(
      this.config.itemsDir,
      imported.capturedAt.slice(0, 4),
      path.basename(sourcePath),
    );
    await mkdir(path.dirname(destination), { recursive: true });
    await atomicWrite(destination, raw);
    return parseItemMarkdown(raw, destination);
  }

  async save(
    frontmatter: ItemFrontmatter,
    insightMarkdown: string,
    sourceMarkdown: string,
    existingPath?: string,
  ): Promise<ShelfItem> {
    const year = frontmatter.capturedAt.slice(0, 4);
    const filePath =
      existingPath ??
      path.join(
        this.config.itemsDir,
        year,
        `${slugify(frontmatter.title)}--${frontmatter.id.slice(0, 8)}.md`,
      );
    await mkdir(path.dirname(filePath), { recursive: true });
    const raw = renderItemMarkdown(frontmatter, insightMarkdown, sourceMarkdown);
    await atomicWrite(filePath, raw);
    return parseItemMarkdown(raw, filePath);
  }

  async archive(item: ShelfItem): Promise<void> {
    const dir = path.join(this.config.historyDir, item.id);
    await mkdir(dir, { recursive: true });
    const timestamp = new Date().toISOString().replaceAll(":", "-");
    const raw = await readFile(item.filePath, "utf8");
    await atomicWrite(
      path.join(
        dir,
        `${timestamp}--${item.enrichment.recipe}-${item.enrichment.recipeHash?.slice(0, 8) ?? "pending"}.md`,
      ),
      raw,
    );
  }

  async remove(item: ShelfItem): Promise<void> {
    await rm(item.filePath);
    await rm(path.join(this.config.historyDir, item.id), { recursive: true, force: true });
  }

  async itemFiles(): Promise<string[]> {
    return walkMarkdown(this.config.itemsDir);
  }

  async recipes(): Promise<Recipe[]> {
    const files = await walkMarkdown(this.config.recipesDir);
    return Promise.all(
      files.map(async (filePath) => parseRecipe(await readFile(filePath, "utf8"), filePath)),
    );
  }

  async recipe(name: string): Promise<Recipe> {
    const recipes = await this.recipes();
    const recipe = recipes.find((candidate) => candidate.name === name);
    if (!recipe) throw new Error(`Recipe ${name} was not found`);
    return recipe;
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function atomicWrite(filePath: string, contents: string): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, contents, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, filePath);
}

async function walkMarkdown(root: string): Promise<string[]> {
  const results: string[] = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) results.push(...(await walkMarkdown(filePath)));
    else if (entry.isFile() && entry.name.endsWith(".md")) results.push(filePath);
  }
  return results;
}

function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 72);
  return slug || `untitled-${sha256(value).slice(0, 8)}`;
}
