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

describe("optional web password", () => {
  const origin = "https://shelf.example";
  const password = "example-secret";

  async function signIn(app: ReturnType<typeof createApp>, base = "") {
    const response = await app.request(`${origin}${base}/auth/login`, {
      method: "POST",
      headers: { origin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password, next: `${base}/items/item-id` }).toString(),
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("Secure");
    expect(response.headers.get("set-cookie")).toContain("SameSite=Strict");
    return response.headers.get("set-cookie")!.split(";")[0]!;
  }

  it("blocks all library routes before handlers run and leaves only health and sign-in public", async () => {
    const webRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ushelf-auth-web-"));
    try {
      await fs.writeFile(
        path.join(webRoot, "index.html"),
        "<html><head></head><body>private shell</body></html>",
      );
      await fs.writeFile(path.join(webRoot, "app.js"), "private app asset");
      let called = false;
      const service = new Proxy({} as ShelfService, {
        get: () => () => {
          called = true;
          throw new Error("handler reached");
        },
      });
      const app = createApp(service, webRoot, "/", { password });
      for (const path of [
        "/api/items",
        "/api/items/item-id",
        "/api/items/item-id/original",
        `/api/items/item-id/media/${"a".repeat(64)}.png`,
        "/api/recipes",
        "/api/kindle/status",
        "/api/kindle/devices",
      ]) {
        const response = await app.request(`${origin}${path}`);
        expect(response.status, path).toBe(401);
        expect(response.headers.get("cache-control"), path).toBe("no-store");
      }
      for (const [path, method] of [
        ["/api/items/item-id/reading", "PATCH"],
        ["/api/items/item-id/kindle-deliveries", "POST"],
      ] as const) {
        expect((await app.request(`${origin}${path}`, { method })).status).toBe(401);
      }
      for (const path of ["/", "/items/item-id", "/index.html", "/app.js"]) {
        const response = await app.request(`${origin}${path}`, {
          headers: { accept: "text/html" },
        });
        expect(response.status, path).toBe(303);
        expect(response.headers.get("location"), path).toContain("/auth/login");
      }
      expect(called).toBe(false);
      await expect((await app.request(`${origin}/api/health`)).json()).resolves.toEqual({
        ok: true,
        authRequired: true,
      });
      expect((await app.request(`${origin}/auth/login`)).status).toBe(200);
      const cookie = await signIn(app);
      const asset = await app.request(`${origin}/app.js`, { headers: { cookie } });
      expect(await asset.text()).toBe("private app asset");
      expect(asset.headers.get("cache-control")).toBe("no-store");
    } finally {
      await fs.rm(webRoot, { recursive: true, force: true });
    }
  });

  it("authenticates, protects writes by origin, expires sessions, and logs out", async () => {
    let time = 1_000_000;
    const service = {
      listItems: () => [],
      getMediaFile: async () => ({ bytes: Buffer.from("image"), mediaType: "image/png" }),
    } as unknown as ShelfService;
    const app = createApp(service, undefined, "/", { password, now: () => time });
    const wrong = await app.request(`${origin}/auth/login`, {
      method: "POST",
      headers: { origin, "content-type": "application/x-www-form-urlencoded" },
      body: "password=wrong",
    });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("set-cookie")).toBeNull();
    const insecure = await app.request("http://shelf.example/auth/login", {
      method: "POST",
      headers: {
        origin: "http://shelf.example",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: `password=${password}`,
    });
    expect(insecure.status).toBe(403);
    const oversized = await app.request(`${origin}/auth/login`, {
      method: "POST",
      headers: { origin, "content-type": "application/x-www-form-urlencoded" },
      body: `password=${"x".repeat(9000)}`,
    });
    expect(oversized.status).toBe(400);
    const cookie = await signIn(app);
    expect(
      (
        await createApp(service, undefined, "/", { password }).request(`${origin}/api/items`, {
          headers: { cookie },
        })
      ).status,
    ).toBe(401);
    expect(cookie).toMatch(/^__Host-ushelf-session=/);
    const login = await app.request(`${origin}/auth/login`, { headers: { cookie } });
    expect(login.status).toBe(303);
    const list = await app.request(`${origin}/api/items`, { headers: { cookie } });
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toEqual({ items: [] });
    const media = await app.request(`${origin}/api/items/item-id/media/${"a".repeat(64)}.png`, {
      headers: { cookie },
    });
    expect(media.status).toBe(200);
    expect(media.headers.get("cache-control")).toBe("no-store");
    const crossSite = await app.request(`${origin}/api/auth/logout`, {
      method: "POST",
      headers: { cookie, origin: "https://evil.example" },
    });
    expect(crossSite.status).toBe(403);
    const logout = await app.request(`${origin}/api/auth/logout`, {
      method: "POST",
      headers: { cookie, origin },
    });
    expect(logout.status).toBe(200);
    expect((await app.request(`${origin}/api/items`, { headers: { cookie } })).status).toBe(401);
    const nextCookie = await signIn(app);
    time += 12 * 60 * 60 * 1000 + 1;
    expect(
      (await app.request(`${origin}/api/items`, { headers: { cookie: nextCookie } })).status,
    ).toBe(401);
  });

  it("rate limits failed sign-ins and keeps subpath redirects inside the mount", async () => {
    const app = createApp({} as ShelfService, undefined, "/reader/", { password });
    for (let attempt = 0; attempt < 10; attempt++) {
      const response = await app.request(`${origin}/reader/auth/login`, {
        method: "POST",
        headers: { origin, "content-type": "application/x-www-form-urlencoded" },
        body: "password=wrong",
      });
      expect(response.status).toBe(401);
    }
    const limited = await app.request(`${origin}/reader/auth/login`, {
      method: "POST",
      headers: { origin, "content-type": "application/x-www-form-urlencoded" },
      body: `password=${password}`,
    });
    expect(limited.status).toBe(429);
    const fresh = createApp({} as ShelfService, undefined, "/reader/", { password });
    const cookie = await signIn(fresh, "/reader");
    expect((await fresh.request(`${origin}/reader/api/health`)).status).toBe(200);
    expect((await fresh.request(`${origin}/api/items`, { headers: { cookie } })).status).toBe(404);
    const response = await fresh.request(
      `${origin}/reader/auth/login?next=${encodeURIComponent("//evil.example")}`,
      { headers: { cookie } },
    );
    expect(response.headers.get("location")).toBe("/reader/");
  });
});
