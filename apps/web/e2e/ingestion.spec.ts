import { expect, test } from "@playwright/test";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ShelfService,
  resolveConfig,
  type IngestResult,
} from "../../../packages/core/dist/index.js";

const xUrl = "https://x.com/XOpenSource/status/2087951962004230428";
const blogUrl =
  "https://rhonabwy.com/2026/08/15/software-engineering-fundamentals-matter-more-than-ever/";
const blogCanonicalUrl =
  "https://rhonabwy.com/2026/08/15/software-engineering-fundamentals-matter-more-than-ever";

test("ingests public X content into canonical Markdown", async () => {
  await withTemporaryShelf(async (service) => {
    const result = await ingestLiveUrl(service, xUrl);

    expect(result.duplicate).toBe(false);
    expect(result.state).toBe("awaiting_enrichment");
    expect(result.item).toMatchObject({
      originalUrl: xUrl,
      canonicalUrl: xUrl,
      sourceType: "x",
      title: expect.stringContaining("X Open Source"),
      extraction: { status: "complete", method: "public_extract" },
      enrichment: { status: "pending", recipe: "default" },
    });
    expect(result.item.sourceMarkdown).toContain("Open-sourcing the For You timeline");
    await expectLocalizedImage(result, /X Open Source/);
    expect(result.item.sourceMarkdown).toContain(`[View post on X](${xUrl})`);

    await expectCanonicalDocument(result, {
      title: result.item.title,
      originalUrl: xUrl,
      canonicalUrl: xUrl,
      sourceAnchor: "Open-sourcing the For You timeline",
    });
  });
});

test("ingests a readable article into canonical Markdown", async () => {
  await withTemporaryShelf(async (service) => {
    const result = await ingestLiveUrl(service, blogUrl);

    expect(result.duplicate).toBe(false);
    expect(result.state).toBe("awaiting_enrichment");
    expect(result.item).toMatchObject({
      originalUrl: blogUrl,
      canonicalUrl: blogCanonicalUrl,
      sourceType: "article",
      title: "Software Engineering fundamentals matter more than ever",
      extraction: { status: "complete", method: "readability" },
      enrichment: { status: "pending", recipe: "default" },
    });
    expect(result.item.author).toContain("heckj");
    expect(result.item.sourceMarkdown.length).toBeGreaterThan(3_000);
    await expectLocalizedImage(result);
    expect(result.item.sourceMarkdown).toContain(
      "The manifestation of my imposter syndrome, for me and today",
    );
    expect(result.item.sourceMarkdown).toContain("And yes, I wrote the damn em-dashes myself");
    expect(result.item.sourceMarkdown).toContain(
      "[The Illusion of Thinking](https://machinelearning.apple.com/research/illusion-of-thinking)",
    );

    await expectCanonicalDocument(result, {
      title: "Software Engineering fundamentals matter more than ever",
      originalUrl: blogUrl,
      canonicalUrl: blogCanonicalUrl,
      sourceAnchor: "The manifestation of my imposter syndrome",
    });
  });
});

async function ingestLiveUrl(service: ShelfService, url: string): Promise<IngestResult> {
  const result = await service.ingestUrl(url);
  if (
    result.item.extraction.status === "failed" &&
    result.item.extraction.error &&
    isLiveSourceUnavailable(result.item.extraction.error)
  ) {
    const warning = `Live ingestion URL is unavailable; skipping regression test: ${url} (${result.item.extraction.error})`;
    console.warn(warning);
    test.skip(true, warning);
  }
  return result;
}

function isLiveSourceUnavailable(error: string): boolean {
  return /Source returned HTTP (?:403|404|410|429|5\d\d)|fetch failed|network|timed? ?out|aborted|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET/i.test(
    error,
  );
}

async function withTemporaryShelf(run: (service: ShelfService) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "ushelf-live-ingestion-"));
  try {
    const recipesDir = path.join(root, "recipes");
    await mkdir(recipesDir, { recursive: true });
    await copyFile(path.resolve("recipes/default.md"), path.join(recipesDir, "default.md"));
    const service = new ShelfService(resolveConfig(root));
    await service.initialize();
    await run(service);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function expectLocalizedImage(result: IngestResult, alt?: RegExp): Promise<void> {
  const image = result.item.sourceMarkdown.match(/!\[([^\]]*)]\((\.\.\/\.\.\/files\/[^)]+)\)/);
  expect(image?.[1]).toMatch(alt ?? /.+/);
  expect(result.item.sourceMarkdown).not.toMatch(/!\[[^\]]*]\(https?:\/\//);
  expect(result.item.media.source.localized).toBeGreaterThan(0);
  const relativePath = image?.[2];
  expect(relativePath).toBeTruthy();
  const bytes = await readFile(path.resolve(path.dirname(result.item.filePath), relativePath!));
  expect(bytes.byteLength).toBeGreaterThan(0);
}

async function expectCanonicalDocument(
  result: IngestResult,
  expected: { title: string; originalUrl: string; canonicalUrl: string; sourceAnchor: string },
): Promise<void> {
  const document = await readFile(result.item.filePath, "utf8");
  expect(document).toContain(`title: ${expected.title}`);
  expect(document).toContain("canonicalUrl:");
  expect(document).toContain(expected.canonicalUrl);
  expect(document).toContain(`# ${expected.title}`);
  expect(document).toContain(`[Open original](${expected.originalUrl})`);
  expect(document).toContain("<!-- ushelf:insights:start -->");
  expect(document).toContain("_Waiting for an agent to add insights._");
  expect(document).toContain("<!-- ushelf:source:start -->");
  expect(document).toContain(expected.sourceAnchor);
  expect(document).toContain("<!-- ushelf:source:end -->");
  expect(document).toContain(result.item.sourceMarkdown);
}
