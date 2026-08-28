import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "@hono/node-server/serve-static";
import { readingStatusSchema, ShelfService, sourceTypeSchema } from "@ushelf/core";
import { readFileSync } from "node:fs";
import path from "node:path";

export function createApp(service: ShelfService, webRoot?: string, basePath = "/") {
  const app = new Hono();
  const normalizedBasePath = normalizeBasePath(basePath);
  const prefix = normalizedBasePath === "/" ? "" : normalizedBasePath.replace(/\/$/, "");
  const route = (path: string) => `${prefix}${path}`;
  app.use(route("/api/*"), cors({ origin: ["http://127.0.0.1:43111", "http://localhost:43111"] }));

  app.get(route("/api/health"), (c) => c.json({ ok: true }));
  app.get(route("/api/items"), (c) => {
    const statusValue = c.req.query("status");
    const sourceValue = c.req.query("sourceType");
    return c.json({
      items: service.listItems({
        ...(c.req.query("q") ? { query: c.req.query("q") } : {}),
        ...(statusValue ? { status: readingStatusSchema.parse(statusValue) } : {}),
        ...(sourceValue ? { sourceType: sourceTypeSchema.parse(sourceValue) } : {}),
        ...(c.req.query("tag") ? { tag: c.req.query("tag") } : {}),
        limit: Number(c.req.query("limit") ?? 100),
        offset: Number(c.req.query("offset") ?? 0),
      }),
    });
  });
  app.get(route("/api/items/:id"), async (c) =>
    c.json({ item: await service.getItem(c.req.param("id")!) }),
  );
  app.get(route("/api/items/:id/original"), async (c) => {
    const file = await service.getOriginalFile(c.req.param("id")!);
    return c.body(new Uint8Array(file.bytes), 200, {
      "content-type": file.mediaType,
      "content-disposition": `inline; filename="original.pdf"; filename*=UTF-8''${encodeHeaderFilename(file.name)}`,
      "x-content-type-options": "nosniff",
    });
  });
  app.patch(route("/api/items/:id/reading"), async (c) => {
    const body = await c.req.json<{ status: string; progress: number; revision?: string }>();
    const item = await service.updateReading(
      c.req.param("id")!,
      readingStatusSchema.parse(body.status),
      Number(body.progress),
      body.revision,
    );
    return c.json({ item });
  });
  app.get(route("/api/recipes"), async (c) => c.json({ recipes: await service.listRecipes() }));

  app.onError((error, c) => {
    console.error(error);
    const notFound = /not found/i.test(error.message);
    return c.json({ error: error.message }, notFound ? 404 : 400);
  });

  if (webRoot) {
    const indexHtml = injectRuntimeBasePath(
      readFileSync(path.join(webRoot, "index.html"), "utf8"),
      normalizedBasePath,
    );
    const webRoute = route("/*");
    app.get(route("/"), (c) => c.html(indexHtml));
    app.get(route("/index.html"), (c) => c.html(indexHtml));
    app.use(
      webRoute,
      serveStatic({
        root: webRoot,
        rewriteRequestPath: (requestPath) =>
          prefix ? requestPath.slice(prefix.length) || "/" : requestPath,
      }),
    );
    app.get(webRoute, (c) => c.html(indexHtml));
  }
  return app;
}

function encodeHeaderFilename(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function normalizeBasePath(value: string): string {
  const normalized = value.trim() || "/";
  if (
    !normalized.startsWith("/") ||
    normalized.startsWith("//") ||
    !/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(normalized)
  ) {
    throw new Error("USHELF_WEB_BASE_PATH must be a safe absolute URL path");
  }
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

function injectRuntimeBasePath(html: string, basePath: string): string {
  const scriptValue = JSON.stringify(basePath).replaceAll("<", "\\u003c");
  return html.replace(
    "<head>",
    `<head><base href="${basePath}"><script>globalThis.__USHELF_BASE_PATH__=${scriptValue};</script>`,
  );
}
