import { createHash } from "node:crypto";
import matter from "gray-matter";
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

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sourceLine(frontmatter: ItemFrontmatter): string {
  const author = frontmatter.author ? ` · ${frontmatter.author}` : "";
  return `[Open original](${frontmatter.originalUrl})${author}`;
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
          summary ? `### Summary\n\n${summary}` : "",
          keyPoints.length
            ? `### Key points\n\n${keyPoints.map((point) => `- ${point}`).join("\n")}`
            : "",
          `${CUSTOM_INSIGHTS_START}\n${insightMarkdown.trim()}\n${CUSTOM_INSIGHTS_END}`,
          citations.length
            ? `### Citations\n\n${citations.map((citation) => `- [${citation.label}](${citation.url})`).join("\n")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n\n")
      : "_Waiting for an agent to add insights._";

  const body = [
    `# ${frontmatter.title}`,
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
    sourceMarkdown.trim() || "_Source content has not been supplied yet._",
    SOURCE_END,
    "",
  ].join("\n");

  return matter.stringify(body, frontmatter);
}

function section(body: string, start: string, end: string): string {
  const startIndex = body.indexOf(start);
  const endIndex = body.indexOf(end);
  if (startIndex < 0 || endIndex < startIndex) return "";
  return body.slice(startIndex + start.length, endIndex).trim();
}

export function parseItemMarkdown(raw: string, filePath: string): ShelfItem {
  const parsed = matter(raw);
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
  const parsed = matter(raw);
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
