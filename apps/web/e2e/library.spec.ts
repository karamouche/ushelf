import { expect, test } from "@playwright/test";

test("empty library is calm, searchable, and responsive", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "uShelf home" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Everything" })).toBeVisible();
  await expect(page.getByPlaceholder("Search ideas, titles, tags…")).toBeVisible();
  await expect(page.getByText("Nothing on this shelf yet")).toBeVisible();
  await expect(page.getByText("Local, portable, and agent-driven.")).toBeVisible();
});
