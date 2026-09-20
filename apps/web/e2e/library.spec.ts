import { expect, test } from "@playwright/test";

test("empty library is calm, searchable, and responsive", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "uShelf home" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Everything" })).toBeVisible();
  await expect(page.getByPlaceholder("Search ideas, titles, tags…")).toBeVisible();
  await expect(page.getByText("Nothing on this shelf yet")).toBeVisible();
  await expect(page.getByText("Local, portable, and agent-driven.")).toBeVisible();
});

test("Mermaid source renders as a diagram and falls back when invalid", async ({ page }) => {
  await page.context().route("**/api/items/*", async (route) => {
    const segments = new URL(route.request().url()).pathname.split("/");
    const id = segments.at(-1) === "reading" ? (segments.at(-2) ?? "") : (segments.at(-1) ?? "");
    const sourceMarkdown =
      id === "valid-mermaid"
        ? "```mermaid\nflowchart LR\n  Capture --> Read\n```"
        : "```mermaid\nthis is not valid Mermaid syntax\n```";
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ item: mermaidItem(id, sourceMarkdown) }),
    });
  });

  await page.goto("/items/valid-mermaid");
  await expect(page.getByRole("img", { name: "Mermaid diagram" }).locator("svg")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.locator("code.language-mermaid")).toHaveCount(0);

  await page.goto("/items/invalid-mermaid");
  await expect(page.getByRole("alert")).toContainText("Diagram could not be rendered");
  await expect(page.locator("code.language-mermaid")).toContainText(
    "this is not valid Mermaid syntax",
  );
});

test("document reader opens the retained PDF and links page citations", async ({ page }) => {
  await page.context().route("**/api/items/pdf-document", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        item: {
          id: "pdf-document",
          title: "Useful report",
          sourceType: "document",
          file: {
            name: "useful-report.pdf",
            mediaType: "application/pdf",
            sizeBytes: 1024,
            sha256: "a".repeat(64),
            pageCount: 2,
          },
          capturedAt: "2026-08-20T12:00:00.000Z",
          updatedAt: "2026-08-20T12:00:00.000Z",
          reading: { status: "inbox", progress: 0 },
          tags: [],
          extraction: { status: "complete", method: "pdf_text" },
          enrichment: {
            status: "complete",
            recipe: "default",
            summary: "A saved report.",
            citations: [{ page: 2, label: "Supporting evidence" }],
          },
          media: {
            source: { discovered: 0, localized: 0, omitted: 0, filtered: 0 },
            insights: { discovered: 0, localized: 0, omitted: 0, filtered: 0 },
          },
          sourceMarkdown: "## Page 1\n\nReport text.",
          insightMarkdown: "",
          revision: "0123456789abcdef",
        },
      }),
    });
  });

  await page.goto("/items/pdf-document");
  await expect(page.getByText(/Document · saved/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Open PDF ↗" })).toHaveAttribute(
    "href",
    "/api/items/pdf-document/original",
  );
  await expect(page.getByRole("link", { name: "Page 2 — Supporting evidence" })).toHaveAttribute(
    "href",
    "/api/items/pdf-document/original#page=2",
  );
});

test("reader loads only content-addressed local Markdown images", async ({ page }) => {
  const itemId = "local-media";
  const filename = `${"a".repeat(64)}.png`;
  const remoteRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith("https://remote.example.test/"))
      remoteRequests.push(request.url());
  });
  await page.context().route(`**/api/items/${itemId}`, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        item: {
          ...mermaidItem(
            itemId,
            `![Saved locally](../../files/${itemId}/media/${filename})\n\n![Remote](https://remote.example.test/image.png)`,
          ),
          media: {
            source: { discovered: 2, localized: 1, omitted: 1, filtered: 0 },
            insights: { discovered: 0, localized: 0, omitted: 0, filtered: 0 },
          },
        },
      }),
    });
  });
  await page.context().route(`**/api/items/${itemId}/media/${filename}`, async (route) => {
    await route.fulfill({
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n3sAAAAASUVORK5CYII=",
        "base64",
      ),
    });
  });

  await page.goto(`/items/${itemId}`);
  await expect(page.getByRole("img", { name: "Saved locally" })).toBeVisible();
  await expect(page.getByText("Image omitted: Remote.")).toBeVisible();
  expect(remoteRequests).toEqual([]);
});

test("reader sends source content to an explicitly selected Kindle device", async ({ page }) => {
  const itemId = "kindle-item";
  let requestedTarget = "";
  await page.context().route(`**/api/items/${itemId}`, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ item: mermaidItem(itemId, "A complete saved source.") }),
    });
  });
  await page.context().route("**/api/kindle/status", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ configured: true, accountName: "Reader", homeRegion: "NA" }),
    });
  });
  await page.context().route("**/api/kindle/devices", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        devices: [
          { name: "Paperwhite", serial: "DEVICE1234" },
          { name: "Kindle app", serial: "APP5678" },
        ],
      }),
    });
  });
  await page.context().route(`**/api/items/${itemId}/kindle-deliveries`, async (route) => {
    requestedTarget = (route.request().postDataJSON() as { targetSerial: string }).targetSerial;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        sku: "sku-123",
        itemId,
        revision: "0123456789abcdef",
        targetSerial: requestedTarget,
      }),
    });
  });

  await page.goto(`/items/${itemId}`);
  await page.getByRole("button", { name: "Send to Kindle" }).click();
  await page.getByLabel("Kindle device").selectOption("DEVICE1234");
  await page.getByRole("button", { name: "Send to this device" }).click();
  await expect(page.getByRole("status")).toContainText("Accepted by Send to Kindle");
  expect(requestedTarget).toBe("DEVICE1234");
});

test("reader defaults to the last successfully used Kindle device", async ({ page }) => {
  const itemId = "kindle-remembered-device";
  const devices = [
    { name: "Paperwhite", serial: "DEVICE1234" },
    { name: "Kindle app", serial: "APP5678" },
  ];
  let preferredTargetSerial = "";
  const requestedTargets: string[] = [];

  await page.context().route(`**/api/items/${itemId}`, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ item: mermaidItem(itemId, "A complete saved source.") }),
    });
  });
  await page.context().route(`**/api/items/${itemId}/kindle-deliveries`, async (route) => {
    const targetSerial = (route.request().postDataJSON() as { targetSerial: string }).targetSerial;
    requestedTargets.push(targetSerial);
    preferredTargetSerial = targetSerial;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        sku: `sku-${requestedTargets.length}`,
        itemId,
        revision: "0123456789abcdef",
        targetSerial,
      }),
    });
  });
  await page.context().route("**/api/kindle/status", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ configured: true, accountName: "Reader", homeRegion: "NA" }),
    });
  });
  await page.context().route("**/api/kindle/devices", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        devices,
        ...(preferredTargetSerial ? { preferredTargetSerial } : {}),
      }),
    });
  });

  await page.goto(`/items/${itemId}`);
  await page.getByRole("button", { name: "Send to Kindle" }).click();
  await page.getByLabel("Kindle device").selectOption("APP5678");
  await page.getByRole("button", { name: "Send to this device" }).click();
  await expect(page.getByRole("status")).toContainText("Accepted by Send to Kindle");

  await page.getByRole("button", { name: "Close Send to Kindle" }).click();
  await page.getByRole("button", { name: "Send to Kindle" }).click();
  await expect(page.getByLabel("Kindle device")).toHaveValue("APP5678");
  await page.getByRole("button", { name: "Send to this device" }).click();
  await expect(page.getByRole("status")).toContainText("Accepted by Send to Kindle");
  expect(requestedTargets).toEqual(["APP5678", "APP5678"]);
});

test("reader explains how to configure Kindle when no credential exists", async ({ page }) => {
  const itemId = "kindle-unconfigured";
  await page.context().route(`**/api/items/${itemId}`, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ item: mermaidItem(itemId, "A complete saved source.") }),
    });
  });
  await page.context().route("**/api/kindle/status", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ configured: false }),
    });
  });

  await page.goto(`/items/${itemId}`);
  await page.getByRole("button", { name: "Send to Kindle" }).click();
  await expect(page.getByText("ushelf kindle setup")).toBeVisible();
});

function mermaidItem(id: string, sourceMarkdown: string) {
  return {
    id,
    title: "Mermaid guide",
    originalUrl: "https://docs.example.test/mermaid",
    canonicalUrl: "https://docs.example.test/mermaid",
    sourceType: "article",
    capturedAt: "2026-08-20T12:00:00.000Z",
    updatedAt: "2026-08-20T12:00:00.000Z",
    reading: { status: "inbox", progress: 0 },
    tags: [],
    extraction: { status: "complete", method: "readability" },
    enrichment: { status: "complete", recipe: "default", summary: "A diagram example." },
    media: {
      source: { discovered: 0, localized: 0, omitted: 0, filtered: 0 },
      insights: { discovered: 0, localized: 0, omitted: 0, filtered: 0 },
    },
    sourceMarkdown,
    insightMarkdown: "",
    revision: "0123456789abcdef",
  };
}
