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

function mermaidItem(id: string, sourceMarkdown: string) {
  return {
    id,
    title: "Mermaid guide",
    originalUrl: "https://docs.example.test/mermaid",
    canonicalUrl: "https://docs.example.test/mermaid",
    sourceType: "blog",
    capturedAt: "2026-08-20T12:00:00.000Z",
    updatedAt: "2026-08-20T12:00:00.000Z",
    reading: { status: "inbox", progress: 0 },
    tags: [],
    extraction: { status: "complete", method: "readability" },
    enrichment: { status: "complete", recipe: "default", summary: "A diagram example." },
    sourceMarkdown,
    insightMarkdown: "",
    revision: "0123456789abcdef",
  };
}
