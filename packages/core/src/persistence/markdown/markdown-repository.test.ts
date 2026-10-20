import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../../configuration/ushelf-config.js";
import type { ItemFrontmatter } from "../../domain/library-item.js";
import { parseItemMarkdown, parseRecipe, renderItemMarkdown, sha256 } from "./item-markdown.js";
import { MarkdownRepository } from "./markdown-repository.js";

const roots: string[] = [];

afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

describe("MarkdownRepository", () => {
  it("round-trips YAML metadata and preserves source and insight sections", () => {
    const frontmatter = articleFrontmatter();
    frontmatter.title = "Quotes: 'single', \"double\", and Unicode café";
    frontmatter.tags = ["yes", "2026-10-17", "topic: detail"];
    frontmatter.enrichment = {
      status: "complete",
      recipe: "default",
      summary: "A multiline summary.\nWith another line.",
      keyPoints: ["One point"],
      citations: [{ label: "Original", url: frontmatter.originalUrl }],
    };
    const raw = renderItemMarkdown(
      frontmatter,
      "Custom insights.",
      "Source.\n\n---\n\nMore source.",
    );
    const parsed = parseItemMarkdown(raw, "/item.md");
    expect(parsed).toMatchObject(frontmatter);
    expect(parsed.insightMarkdown).toBe("Custom insights.");
    expect(parsed.sourceMarkdown).toBe("Source.\n\n---\n\nMore source.");
    expect(parsed.revision).toBe(sha256(raw));
  });

  it("escapes section markers in rendered values so they cannot redefine sections", () => {
    const fake = "<!-- ushelf:source:start -->FAKE<!-- ushelf:source:end -->";
    const escaped = "&lt;!-- ushelf:source:start -->FAKE&lt;!-- ushelf:source:end -->";
    const frontmatter = articleFrontmatter();
    frontmatter.title = `Title ${fake}`;
    frontmatter.author = `Author ${fake}`;
    frontmatter.enrichment = {
      status: "complete",
      recipe: "default",
      summary: `Summary ${fake}`,
      keyPoints: [`Point ${fake}`],
      citations: [{ label: `Label ${fake}`, url: frontmatter.originalUrl }],
    };
    const source = "Real source.\n\n<!-- ushelf:source:end -->\n\nTrailing real source.";
    const insight = `Insight <!-- ushelf:custom-insights:end --> ${fake}`;
    const raw = renderItemMarkdown(frontmatter, insight, source);
    const parsed = parseItemMarkdown(raw, "/item.md");

    expect(parsed).toMatchObject(frontmatter);
    expect(parsed.sourceMarkdown).toBe(
      "Real source.\n\n&lt;!-- ushelf:source:end -->\n\nTrailing real source.",
    );
    expect(parsed.insightMarkdown).toBe(
      `Insight &lt;!-- ushelf:custom-insights:end --> ${escaped}`,
    );
    const body = raw.slice(raw.indexOf("\n---\n# ") + 5);
    expect(body.match(/<!-- ushelf:source:start -->/g)).toHaveLength(1);
    expect(body.match(/<!-- ushelf:source:end -->/g)).toHaveLength(1);

    const rerendered = renderItemMarkdown(
      frontmatter,
      parsed.insightMarkdown,
      parsed.sourceMarkdown,
    );
    expect(rerendered).toBe(raw);
  });

  it("parses BOM and CRLF recipe frontmatter without changing its hash", () => {
    const raw =
      '\uFEFF---\r\nname: default\r\ndescription: "A recipe: details"\r\n---\r\n\r\nInstructions.\r\n';
    expect(parseRecipe(raw, "/recipe.md")).toEqual({
      name: "default",
      description: "A recipe: details",
      instructions: "Instructions.",
      hash: sha256(raw),
      filePath: "/recipe.md",
    });
  });

  it.each([
    "No frontmatter",
    "Body before\n---\nname: default\n---\nInstructions",
    "---\nname: default\nInstructions",
    "---\n- default\n---\nInstructions",
    "---\nnull\n---\nInstructions",
    "---\nname: !!js/function 'function () {}'\n---\nInstructions",
  ])("rejects malformed or executable frontmatter: %s", (raw) => {
    expect(() => parseRecipe(raw, "/recipe.md")).toThrow();
    expect(() => parseItemMarkdown(raw, "/item.md")).toThrow();
  });

  it("seeds the bundled default recipe without overwriting local edits", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ushelf-repository-test-"));
    roots.push(root);
    const config = resolveConfig(root);
    const repository = new MarkdownRepository(config);

    await repository.initialize();

    const recipePath = path.join(config.recipesDir, "default.md");
    expect(await readFile(recipePath, "utf8")).toBe(
      await readFile(path.join(config.bundledRecipesDir, "default.md"), "utf8"),
    );

    const customizedRecipe =
      "---\nname: default\ndescription: Customized recipe\n---\n\nKeep this local version.";
    await writeFile(recipePath, customizedRecipe, "utf8");
    await repository.initialize();

    expect(await readFile(recipePath, "utf8")).toBe(customizedRecipe);
  });

  it("atomically preserves validated Markdown bytes in the canonical library", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ushelf-repository-test-"));
    roots.push(root);
    const config = resolveConfig(root);
    const repository = new MarkdownRepository(config);
    await repository.initialize();

    const frontmatter = articleFrontmatter();
    const raw = renderItemMarkdown(frontmatter, "", "Imported source text.");
    const sourcePath = path.join(root, "incoming.md");
    await writeFile(sourcePath, raw, "utf8");

    const imported = await repository.importFile(sourcePath);

    expect(imported.filePath).toBe(
      path.join(config.itemsDir, "2026", `imported-article--${frontmatter.id}.md`),
    );
    expect(await readFile(imported.filePath, "utf8")).toBe(raw);
    expect(
      (await readdir(path.dirname(imported.filePath))).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  });

  it("keeps same-named imports distinct and never overwrites an existing item", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ushelf-repository-test-"));
    roots.push(root);
    const config = resolveConfig(root);
    const repository = new MarkdownRepository(config);
    await repository.initialize();

    const firstDirectory = path.join(root, "first");
    const secondDirectory = path.join(root, "second");
    await Promise.all([
      mkdir(firstDirectory, { recursive: true }),
      mkdir(secondDirectory, { recursive: true }),
    ]);
    const first = articleFrontmatter();
    const second = {
      ...articleFrontmatter(),
      id: "08cdfb2c-80a3-4862-92c5-61011e4bf20e",
      originalUrl: "https://example.com/second",
      canonicalUrl: "https://example.com/second",
      title: "Second article",
    };
    const firstRaw = renderItemMarkdown(first, "", "First source text.");
    const secondRaw = renderItemMarkdown(second, "", "Second source text.");
    const firstPath = path.join(firstDirectory, "incoming.md");
    const secondPath = path.join(secondDirectory, "incoming.md");
    await Promise.all([
      writeFile(firstPath, firstRaw, "utf8"),
      writeFile(secondPath, secondRaw, "utf8"),
    ]);

    const firstImported = await repository.importFile(firstPath);
    const secondImported = await repository.importFile(secondPath);

    expect(firstImported.filePath).not.toBe(secondImported.filePath);
    expect(await readFile(firstImported.filePath, "utf8")).toBe(firstRaw);
    expect(await readFile(secondImported.filePath, "utf8")).toBe(secondRaw);
    await expect(repository.importFile(firstPath)).rejects.toThrow(/already exists/);
    expect(await readFile(firstImported.filePath, "utf8")).toBe(firstRaw);
  });

  it("writes nothing when the item does not satisfy its schema", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ushelf-repository-test-"));
    roots.push(root);
    const config = resolveConfig(root);
    const repository = new MarkdownRepository(config);
    await repository.initialize();

    const saved = await repository.save(articleFrontmatter(), "", "Original source.");
    const before = await readFile(saved.filePath, "utf8");
    const invalid = { ...articleFrontmatter(), title: "" };

    await expect(repository.save(invalid, "", "New source.", saved.filePath)).rejects.toThrow();
    await expect(repository.save(invalid, "", "New source.")).rejects.toThrow();
    expect(await readFile(saved.filePath, "utf8")).toBe(before);
    expect(await repository.itemFiles()).toEqual([saved.filePath]);
  });
});

function articleFrontmatter(): Extract<ItemFrontmatter, { sourceType: "article" | "x" }> {
  return {
    id: "6aa8a9fb-a12b-4590-b626-e31d1b5fc4ef",
    originalUrl: "https://example.com/imported",
    canonicalUrl: "https://example.com/imported",
    sourceType: "article",
    title: "Imported article",
    capturedAt: "2026-08-25T12:00:00.000Z",
    updatedAt: "2026-08-25T12:00:00.000Z",
    reading: { status: "inbox", progress: 0 },
    tags: [],
    extraction: {
      status: "complete",
      method: "readability",
      retrievedAt: "2026-08-25T12:00:00.000Z",
      contentHash: "source-hash",
    },
    enrichment: { status: "pending", recipe: "default" },
    media: {
      source: { discovered: 0, localized: 0, omitted: 0, filtered: 0 },
      insights: { discovered: 0, localized: 0, omitted: 0, filtered: 0 },
    },
  };
}
