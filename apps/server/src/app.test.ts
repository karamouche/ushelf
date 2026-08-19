import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ShelfService } from "@ushelf/core";
import { createApp } from "./app.js";

describe("createApp base path", () => {
  it("mounts the API below the configured base path", async () => {
    const app = createApp({} as ShelfService, undefined, "/reader/");

    const prefixed = await app.request("/reader/api/health");
    expect(prefixed.status).toBe(200);
    await expect(prefixed.json()).resolves.toEqual({ ok: true });

    const unprefixed = await app.request("/api/health");
    expect(unprefixed.status).toBe(404);
  });

  it("keeps the API at the root when no base path is configured", async () => {
    const app = createApp({} as ShelfService);
    const response = await app.request("/api/health");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("serves assets and SPA routes only below the configured base path", async () => {
    const webRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ushelf-web-"));
    try {
      await fs.writeFile(path.join(webRoot, "index.html"), "<main>reader</main>");
      await fs.writeFile(path.join(webRoot, "app.js"), "console.log('reader')");
      const app = createApp({} as ShelfService, webRoot, "/reader/");

      const asset = await app.request("/reader/app.js");
      expect(asset.status).toBe(200);
      expect(await asset.text()).toBe("console.log('reader')");

      const spaRoute = await app.request("/reader/items/example");
      expect(spaRoute.status).toBe(200);
      expect(await spaRoute.text()).toBe("<main>reader</main>");

      expect((await app.request("/app.js")).status).toBe(404);
    } finally {
      await fs.rm(webRoot, { recursive: true, force: true });
    }
  });
});
