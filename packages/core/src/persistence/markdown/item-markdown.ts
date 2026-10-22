import { createHash } from "node:crypto";
import { dump, load } from "js-yaml";
import {
  itemFrontmatterSchema,
  type ItemFrontmatter,
  type ShelfItem,
} from "../../domain/library-item.js";
import type { Recipe } from "../../domain/recipe.js";

const SOURCE_START = "<!-- ushelf:source:start -->";
const SOURCE_END = "<!-- ushelf:source:end -->";
const MARKER_PREFIX = "<!-- ushelf:";

/**
 * Every value rendered into the item body must pass through this so that only the codec's own
 * markers delimit sections. Escaping `<` displays the same text but never yields `<!--`, so the
 * result is stable across render/parse round trips.
 */
function neutralizeMarkers(value: string): string {
  return value.replaceAll(MARKER_PREFIX, "&lt;!-- ushelf:");
}

function parseFrontmatter(raw: string): { data: Record<string, unknown>; content: string } {
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m.exec(raw);
  if (!match || match.index !== 0) throw new Error("Missing YAML frontmatter");
  const data: unknown = load(match[1] ?? "");
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("YAML frontmatter must be an object");
  }
  return { data: data as Record<string, unknown>, content: raw.slice(match[0].length) };
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sourceLine(frontmatter: ItemFrontmatter): string {
  if (frontmatter.sourceType === "document") {
    return `Original file: ${neutralizeMarkers(frontmatter.file.name)}`;
  }
  const author = frontmatter.author ? ` · ${neutralizeMarkers(frontmatter.author)}` : "";
  return `[Open original](${neutralizeMarkers(frontmatter.originalUrl)})${author}`;
}

export function renderItemMarkdown(frontmatter: ItemFrontmatter, sourceMarkdown: string): string {
  const body = [
    `# ${neutralizeMarkers(frontmatter.title)}`,
    "",
    sourceLine(frontmatter),
    "",
    "## Source",
    "",
    SOURCE_START,
    neutralizeMarkers(sourceMarkdown.trim()) || "_Source content has not been supplied yet._",
    SOURCE_END,
    "",
  ].join("\n");

  return `---\n${dump(frontmatter)}---\n${body}`;
}

function section(body: string, start: string, end: string): string {
  // Rendered values never contain markers; pairing the first start with the last end also keeps a
  // stray hand-edited end marker from truncating a section.
  const startIndex = body.indexOf(start);
  const endIndex = body.lastIndexOf(end);
  if (startIndex < 0 || endIndex < startIndex) return "";
  return body.slice(startIndex + start.length, endIndex).trim();
}

export function parseItemMarkdown(raw: string, filePath: string): ShelfItem {
  const parsed = parseFrontmatter(raw);
  const frontmatter = itemFrontmatterSchema.parse(parsed.data);
  const sourceMarkdown = section(parsed.content, SOURCE_START, SOURCE_END);
  return {
    ...frontmatter,
    filePath,
    sourceMarkdown: sourceMarkdown.startsWith("_Source content has not") ? "" : sourceMarkdown,
    revision: sha256(raw),
  };
}

export function parseRecipe(raw: string, filePath: string): Recipe {
  const parsed = parseFrontmatter(raw);
  const name = String(parsed.data.name ?? "").trim();
  const description = String(parsed.data.description ?? "").trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`Invalid recipe name in ${filePath}`);
  if (!parsed.content.trim()) throw new Error(`Recipe ${name} has no instructions`);
  return {
    name,
    description,
    instructions: parsed.content.trim(),
    hash: sha256(raw),
    filePath,
  };
}
