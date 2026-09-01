import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { unzipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../configuration/ushelf-config.js";
import type { ItemFrontmatter, SourceType } from "../domain/library-item.js";
import { KindleError, type KindleDevice } from "../domain/kindle.js";
import type { KindleGateway } from "../kindle/kindle-bridge.js";
import { MarkdownRepository } from "../persistence/markdown/markdown-repository.js";
import { ShelfService } from "./shelf-service.js";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

class FakeKindleGateway implements KindleGateway {
  devicesValue: KindleDevice[] = [{ name: "Paperwhite", serial: "DEVICE123" }];
  sent?: { bytes: Uint8Array; title: string; author?: string; targetSerial: string };
  sendResult: Promise<string> = Promise.resolve("sku-123");

  async status() {
    return { accountName: "Reader", homeRegion: "NA", serial: "INSTALLATION" };
  }
  async devices() {
    return this.devicesValue;
  }
  async send(input: { bytes: Uint8Array; title: string; author?: string; targetSerial: string }) {
    this.sent = input;
    return this.sendResult;
  }
}

async function fixture(
  sourceType: SourceType = "article",
  sourceMarkdown = sourceType === "document"
    ? "## Page 1\n\nDocument source."
    : "## Source\n\nCaptured source.",
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ushelf-kindle-test-"));
  roots.push(root);
  const config = resolveConfig(root);
  const repository = new MarkdownRepository(config);
  await repository.initialize();
  const now = "2026-08-20T12:00:00.000Z";
  const common = {
    id: "e7cf9d0d-bba8-4b93-9503-ab8f15de9d2f",
    title: `Kindle ${sourceType}`,
    author: "Reader",
    capturedAt: now,
    updatedAt: now,
    reading: { status: "inbox" as const, progress: 0 },
    tags: [],
    extraction: {
      status: "complete" as const,
      method:
        sourceType === "document"
          ? ("pdf_text" as const)
          : sourceType === "x"
            ? ("public_extract" as const)
            : ("readability" as const),
    },
    enrichment: {
      status: "complete" as const,
      recipe: "default",
      summary: "Do not export this insight",
    },
    media: {
      source: { discovered: 0, localized: 0, omitted: 0, filtered: 0 },
      insights: { discovered: 0, localized: 0, omitted: 0, filtered: 0 },
    },
  };
  const frontmatter: ItemFrontmatter =
    sourceType === "document"
      ? {
          ...common,
          sourceType,
          file: {
            name: "paper.pdf",
            mediaType: "application/pdf",
            sizeBytes: 100,
            sha256: "a".repeat(64),
            pageCount: 1,
          },
        }
      : {
          ...common,
          sourceType,
          originalUrl:
            sourceType === "x" ? "https://x.com/a/status/1" : "https://example.com/article",
          canonicalUrl:
            sourceType === "x" ? "https://x.com/a/status/1" : "https://example.com/article",
        };
  const item = await repository.save(
    frontmatter,
    "## Private insight\n\nDo not export.",
    sourceMarkdown,
  );
  const gateway = new FakeKindleGateway();
  const service = new ShelfService(config, { kindleGateway: gateway });
  await service.initialize();
  return { service, gateway, item };
}

describe("ShelfService Kindle delivery", () => {
  for (const sourceType of ["article", "x", "document"] as const) {
    it(`sends source-only EPUB content for ${sourceType}`, async () => {
      const { service, gateway, item } = await fixture(sourceType);
      const result = await service.sendToKindle(item.id, "DEVICE123");
      expect(result).toEqual({
        sku: "sku-123",
        itemId: item.id,
        revision: item.revision,
        targetSerial: "DEVICE123",
      });
      expect(gateway.sent?.targetSerial).toBe("DEVICE123");
      const archive = unzipSync(gateway.sent!.bytes);
      const article = Buffer.from(archive["EPUB/article.xhtml"]!).toString();
      expect(article).toContain(sourceType === "document" ? "Document source" : "Captured source");
      expect(article).not.toContain("Private insight");
      expect((await service.getItem(item.id)).revision).toBe(item.revision);
    });
  }

  it("rejects unknown devices without sending", async () => {
    const { service, gateway, item } = await fixture();
    await expect(service.sendToKindle(item.id, "UNKNOWN")).rejects.toMatchObject({
      code: "device_not_found",
    });
    expect(gateway.sent).toBeUndefined();
  });

  it("returns a redacted export error when a saved source image is missing", async () => {
    const itemId = "e7cf9d0d-bba8-4b93-9503-ab8f15de9d2f";
    const { service, gateway, item } = await fixture(
      "article",
      `![Missing](../../files/${itemId}/media/${"b".repeat(64)}.png)`,
    );
    await expect(service.sendToKindle(item.id, "DEVICE123")).rejects.toEqual(
      new KindleError(
        "export_failed",
        "The Kindle EPUB could not be prepared because its source or saved images are unavailable.",
      ),
    );
    expect(gateway.sent).toBeUndefined();
  });

  it("rejects a concurrent delivery for the same item and device", async () => {
    const { service, gateway, item } = await fixture();
    let finish!: (value: string) => void;
    gateway.sendResult = new Promise((resolve) => {
      finish = resolve;
    });
    const first = service.sendToKindle(item.id, "DEVICE123");
    while (!gateway.sent) await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(service.sendToKindle(item.id, "DEVICE123")).rejects.toEqual(
      new KindleError(
        "delivery_in_progress",
        "A Kindle delivery for this item and device is already in progress.",
      ),
    );
    finish("sku-123");
    await first;
  });
});
