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

test("reader saves the latest position when scrolling down and quickly back up", async ({
  page,
}) => {
  const itemId = "scrolls-both-directions";
  let item = progressItem(itemId);
  const updates: Array<{ progress: number; status: string; revision: string }> = [];
  await page.context().route(new RegExp(`/api/items/${itemId}(?:/reading)?$`), async (route) => {
    if (route.request().method() === "PATCH") {
      const update = route.request().postDataJSON() as (typeof updates)[number];
      updates.push(update);
      item = {
        ...item,
        reading: { status: update.status, progress: update.progress },
        revision: `revision-${updates.length}`,
      };
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ item }) });
  });

  await page.goto(`/items/${itemId}`);
  await expect(page.getByRole("heading", { name: "Scroll progress article" })).toBeVisible();
  await scrollToProgress(page, 0.72);
  await expect.poll(() => visibleProgress(page)).toBeGreaterThan(0.68);
  await expect.poll(() => updates.length).toBe(1);

  await scrollToProgress(page, 0.28);
  await expect.poll(() => visibleProgress(page)).toBeLessThan(0.32);
  await expect.poll(() => updates.length).toBe(2);
  expect(updates[1]!.status).toBe("reading");
  expect(updates[1]!.progress).toBeGreaterThan(0.24);
  expect(updates[1]!.progress).toBeLessThan(0.32);
});

test("reader serializes delayed saves and coalesces to the newest position", async ({ page }) => {
  const itemId = "serialized-scroll-progress";
  let item = progressItem(itemId, "reading");
  const updates: Array<{ progress: number; revision: string }> = [];
  let activeRequests = 0;
  let maximumActiveRequests = 0;
  await page.context().route(new RegExp(`/api/items/${itemId}(?:/reading)?$`), async (route) => {
    if (route.request().method() === "PATCH") {
      activeRequests += 1;
      maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
      const update = route.request().postDataJSON() as { progress: number; revision: string };
      updates.push(update);
      if (updates.length === 1) await new Promise((resolve) => setTimeout(resolve, 1100));
      item = {
        ...item,
        reading: { status: "reading", progress: update.progress },
        revision: `revision-${updates.length}`,
      };
      activeRequests -= 1;
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ item }) });
  });

  await page.goto(`/items/${itemId}`);
  await scrollToProgress(page, 0.25);
  await expect.poll(() => updates.length).toBe(1);
  await scrollToProgress(page, 0.55);
  await scrollToProgress(page, 0.78);

  await expect.poll(() => updates.length).toBe(2);
  expect(maximumActiveRequests).toBe(1);
  expect(updates[0]!.revision).toBe("revision-0");
  expect(updates[1]!.revision).toBe("revision-1");
  expect(updates[1]!.progress).toBeGreaterThan(0.74);
});

test("reader persists during continuous scrolling at the maximum interval", async ({ page }) => {
  const itemId = "continuous-scroll-progress";
  let item = progressItem(itemId, "reading");
  const updates: number[] = [];
  await page.context().route(new RegExp(`/api/items/${itemId}(?:/reading)?$`), async (route) => {
    if (route.request().method() === "PATCH") {
      const update = route.request().postDataJSON() as { progress: number };
      updates.push(update.progress);
      item = {
        ...item,
        reading: { status: "reading", progress: update.progress },
        revision: `revision-${updates.length}`,
      };
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ item }) });
  });

  await page.goto(`/items/${itemId}`);
  await page.waitForTimeout(180);
  for (let index = 1; index <= 18; index += 1) {
    await page.evaluate((progress) => {
      const maximum = document.documentElement.scrollHeight - window.innerHeight;
      window.scrollTo({ top: maximum * progress, behavior: "instant" });
    }, index / 20);
    await page.waitForTimeout(250);
  }

  expect(updates.length).toBeGreaterThanOrEqual(1);
  await page.waitForTimeout(900);
});

test("reader flushes pending progress before SPA back navigation", async ({ page }) => {
  const itemId = "flush-on-back";
  let item = progressItem(itemId);
  const updates: number[] = [];
  await page.context().route(new RegExp(`/api/items/${itemId}(?:/reading)?$`), async (route) => {
    if (route.request().method() === "PATCH") {
      const update = route.request().postDataJSON() as { progress: number };
      updates.push(update.progress);
      item = { ...item, reading: { status: "reading", progress: update.progress } };
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ item }) });
  });
  await page.context().route("**/api/items?*", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ items: [] }) });
  });

  await page.goto("/");
  await page.goto(`/items/${itemId}`);
  await scrollToProgress(page, 0.6);
  await page.getByRole("button", { name: "Back to library" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect.poll(() => updates.length).toBe(1);
  expect(updates[0]).toBeGreaterThan(0.56);
});

test("reader restoration is quiet and Read items stay complete", async ({ page }) => {
  const restoringId = "quiet-restoration";
  const readId = "completed-article";
  const patches: string[] = [];
  await page.context().route("**/api/items/*", async (route) => {
    const segments = new URL(route.request().url()).pathname.split("/");
    const id = segments.at(-1) === "reading" ? segments.at(-2)! : segments.at(-1)!;
    if (route.request().method() === "PATCH") patches.push(id);
    const item =
      id === readId ? progressItem(readId, "read", 1) : progressItem(restoringId, "inbox", 0.4);
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ item }) });
  });

  await page.goto(`/items/${restoringId}`);
  await expect.poll(() => visibleProgress(page)).toBeGreaterThan(0.38);
  await page.waitForTimeout(900);
  expect(patches).toEqual([]);

  await page.goto(`/items/${readId}`);
  await page.waitForTimeout(150);
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(() => visibleProgress(page)).toBe(1);
  await page.waitForTimeout(900);
  expect(patches).toEqual([]);
  await expect(page.getByLabel("Reading status")).toHaveValue("read");
});

test("reader refreshes a stale revision once and reports persistent save failures", async ({
  page,
}) => {
  const staleId = "stale-scroll-progress";
  const failingId = "failed-scroll-progress";
  let staleItem = progressItem(staleId, "reading", 0, "revision-0");
  let stalePatchCount = 0;
  await page.context().route(new RegExp(`/api/items/${staleId}(?:/reading)?$`), async (route) => {
    if (route.request().method() === "PATCH") {
      stalePatchCount += 1;
      if (stalePatchCount === 1) {
        staleItem = { ...staleItem, revision: "revision-external" };
        await route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({
            error: "Item changed since it was read; fetch it again before writing",
          }),
        });
        return;
      }
      const update = route.request().postDataJSON() as { progress: number };
      staleItem = {
        ...staleItem,
        reading: { status: "reading", progress: update.progress },
        revision: "revision-retried",
      };
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ item: staleItem }),
    });
  });
  await page.context().route(new RegExp(`/api/items/${failingId}(?:/reading)?$`), async (route) => {
    if (route.request().method() === "PATCH") {
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: "Disk is unavailable" }),
      });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ item: progressItem(failingId, "reading") }),
    });
  });

  await page.goto(`/items/${staleId}`);
  await scrollToProgress(page, 0.52);
  await expect.poll(() => stalePatchCount).toBe(2);
  expect(staleItem.reading.progress).toBeGreaterThan(0.48);

  await page.goto(`/items/${failingId}`);
  await scrollToProgress(page, 0.52);
  await expect(page.getByRole("alert")).toContainText(
    "Reading position could not be saved. Disk is unavailable",
  );
  await page.waitForTimeout(900);
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

function progressItem(
  id: string,
  status: "inbox" | "reading" | "read" = "inbox",
  progress = 0,
  revision = "revision-0",
) {
  return {
    ...mermaidItem(
      id,
      Array.from(
        { length: 80 },
        (_, index) =>
          `## Section ${index + 1}\n\nThis is enough article text to make the reader page scroll through many distinct positions.`,
      ).join("\n\n"),
    ),
    title: "Scroll progress article",
    reading: { status, progress },
    revision,
  };
}

async function scrollToProgress(page: import("@playwright/test").Page, progress: number) {
  await expect(page.locator(".article > h1")).toBeVisible();
  await page.waitForTimeout(180);
  await page.evaluate((nextProgress) => {
    const maximum = document.documentElement.scrollHeight - window.innerHeight;
    window.scrollTo({ top: maximum * nextProgress, behavior: "instant" });
  }, progress);
}

async function visibleProgress(page: import("@playwright/test").Page): Promise<number> {
  return page.locator(".reading-progress").evaluate((element) => {
    return Number.parseFloat((element as HTMLElement).style.width) / 100;
  });
}
