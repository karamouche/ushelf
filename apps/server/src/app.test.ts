import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { KindleError, type ShelfService } from "@ushelf/core";
import { createApp } from "./app.js";

describe("createApp base path", () => {
  it("exposes Kindle status, devices, and targeted delivery", async () => {
    const service = {
      kindleStatus: async () => ({ configured: true, accountName: "Reader", homeRegion: "NA" }),
      kindleDevices: async () => ({
        devices: [{ name: "Paperwhite", serial: "DEVICE123" }],
        preferredTargetSerial: "DEVICE123",
      }),
      sendToKindle: async (id: string, serial: string) => ({
        sku: "sku-1",
        itemId: id,
        revision: "a".repeat(64),
        targetSerial: serial,
      }),
    } as unknown as ShelfService;
    const app = createApp(service);

    await expect((await app.request("/api/kindle/status")).json()).resolves.toMatchObject({
      configured: true,
      accountName: "Reader",
    });
    await expect((await app.request("/api/kindle/devices")).json()).resolves.toEqual({
      devices: [{ name: "Paperwhite", serial: "DEVICE123" }],
      preferredTargetSerial: "DEVICE123",
    });
    const delivery = await app.request("/api/items/item-id/kindle-deliveries", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetSerial: "DEVICE123" }),
    });
    expect(delivery.status).toBe(200);
    await expect(delivery.json()).resolves.toMatchObject({
      sku: "sku-1",
      itemId: "item-id",
      targetSerial: "DEVICE123",
    });
  });

  it("returns stable Kindle error codes", async () => {
    const service = {
      kindleDevices: async () => {
        throw new KindleError("credential_invalid", "Reconnect Kindle.");
      },
    } as unknown as ShelfService;
    const response = await createApp(service).request("/api/kindle/devices");
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Reconnect Kindle.",
      code: "credential_invalid",
    });
  });

  it("serves retained PDFs inline without exposing their storage path", async () => {
    const service = {
      getOriginalFile: async () => ({
        bytes: Buffer.from("%PDF-test"),
        name: "Useful paper.pdf",
        mediaType: "application/pdf" as const,
      }),
    } as unknown as ShelfService;
    const response = await createApp(service).request("/api/items/item-id/original");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toContain("Useful%20paper.pdf");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe("%PDF-test");
  });

  it("returns not found when a retained PDF is missing", async () => {
    const service = {
      getOriginalFile: async () => {
        throw new Error("Original file was not found");
      },
    } as unknown as ShelfService;

    expect((await createApp(service).request("/api/items/item-id/original")).status).toBe(404);
  });

  it("serves content-addressed local media with restrictive headers", async () => {
    const filename = `${"a".repeat(64)}.png`;
    const service = {
      getMediaFile: async (id: string, requested: string) => {
        expect(id).toBe("item-id");
        expect(requested).toBe(filename);
        return { bytes: Buffer.from([137, 80, 78, 71]), mediaType: "image/png" };
      },
    } as unknown as ShelfService;

    const response = await createApp(service).request(`/api/items/item-id/media/${filename}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

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
      await fs.writeFile(
        path.join(webRoot, "index.html"),
        "<html><head></head><body><main>reader</main></body></html>",
      );
      await fs.writeFile(path.join(webRoot, "app.js"), "console.log('reader')");
      const app = createApp({} as ShelfService, webRoot, "/reader/");

      const asset = await app.request("/reader/app.js");
      expect(asset.status).toBe(200);
      expect(await asset.text()).toBe("console.log('reader')");

      const spaRoute = await app.request("/reader/items/example");
      expect(spaRoute.status).toBe(200);
      const html = await spaRoute.text();
      expect(html).toContain("<main>reader</main>");
      expect(html).toContain('<base href="/reader/">');
      expect(html).toContain('globalThis.__USHELF_BASE_PATH__="/reader/"');

      expect((await app.request("/app.js")).status).toBe(404);
    } finally {
      await fs.rm(webRoot, { recursive: true, force: true });
    }
  });

  it("rejects unsafe base paths", () => {
    expect(() => createApp({} as ShelfService, undefined, '/reader/\"><script>')).toThrow(
      "USHELF_WEB_BASE_PATH",
    );
  });
});
