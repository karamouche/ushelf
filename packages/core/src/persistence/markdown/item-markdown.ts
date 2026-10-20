import { createHash } from "node:crypto";
import { dump, load } from "js-yaml";
import {
  itemFrontmatterSchema,
  type ItemFrontmatter,
  type ShelfItem,
} from "../../domain/library-item.js";
import type { Recipe } from "../../domain/recipe.js";

const INSIGHTS_START = "<!-- ushelf:insights:start -->";
const INSIGHTS_END = "<!-- ushelf:insights:end -->";
const CUSTOM_INSIGHTS_START = "<!-- ushelf:custom-insights:start -->";
const CUSTOM_INSIGHTS_END = "<!-- ushelf:custom-insights:end -->";
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

export function renderItemMarkdown(
  frontmatter: ItemFrontmatter,
  insightMarkdown: string,
  sourceMarkdown: string,
): string {
  const keyPoints = frontmatter.enrichment.keyPoints ?? [];
  const citations = frontmatter.enrichment.citations ?? [];
  const summary = frontmatter.enrichment.summary;
  const insights =
    frontmatter.enrichment.status === "complete"
      ? [
          summary ? `### Summary\n\n${neutralizeMarkers(summary)}` : "",
          keyPoints.length
            ? `### Key points\n\n${keyPoints.map((point) => `- ${neutralizeMarkers(point)}`).join("\n")}`
            : "",
          `${CUSTOM_INSIGHTS_START}\n${neutralizeMarkers(insightMarkdown.trim())}\n${CUSTOM_INSIGHTS_END}`,
          citations.length ? `### Citations\n\n${citations.map(renderCitation).join("\n")}` : "",
        ]
          .filter(Boolean)
          .join("\n\n")
      : "_Waiting for an agent to add insights._";

  const body = [
    `# ${neutralizeMarkers(frontmatter.title)}`,
    "",
    sourceLine(frontmatter),
    "",
    "## Insights",
    "",
    INSIGHTS_START,
    insights,
    INSIGHTS_END,
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

function renderCitation(
  citation: NonNullable<ItemFrontmatter["enrichment"]["citations"]>[number],
): string {
  return "url" in citation
    ? `- [${neutralizeMarkers(citation.label)}](${neutralizeMarkers(citation.url)})`
    : `- Page ${citation.page} — ${neutralizeMarkers(citation.label)}`;
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
  const renderedInsights = section(parsed.content, INSIGHTS_START, INSIGHTS_END);
  const sourceMarkdown = section(parsed.content, SOURCE_START, SOURCE_END);
  return {
    ...frontmatter,
    filePath,
    sourceMarkdown: sourceMarkdown.startsWith("_Source content has not") ? "" : sourceMarkdown,
    insightMarkdown: extractCustomInsight(renderedInsights),
    revision: sha256(raw),
  };
}

function extractCustomInsight(rendered: string): string {
  if (!rendered || rendered.startsWith("_Waiting for")) return "";
  const marked = section(rendered, CUSTOM_INSIGHTS_START, CUSTOM_INSIGHTS_END);
  if (rendered.includes(CUSTOM_INSIGHTS_START)) return marked;
  const beforeCitations = rendered.split(/\n### Citations\n/)[0] ?? "";
  const afterKeyPoints = beforeCitations.split(/\n### Key points\n[\s\S]*?(?=\n### |$)/);
  const withoutSummary = (afterKeyPoints.at(-1) ?? beforeCitations)
    .replace(/^### Summary\n\n[\s\S]*?(?=\n### |$)/, "")
    .trim();
  return withoutSummary;
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
