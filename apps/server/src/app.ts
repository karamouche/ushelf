import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "@hono/node-server/serve-static";
import { readingStatusSchema, ShelfService, sourceTypeSchema } from "@ushelf/core";

export function createApp(service: ShelfService, webRoot?: string, basePath = "/") {
  const app = new Hono();
  const prefix = basePath === "/" ? "" : basePath.replace(/\/$/, "");
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
  app.get(route("/api/recipes"), async (c) =>
    c.json({ recipes: await service.repository.recipes() }),
  );

  app.onError((error, c) => {
    console.error(error);
    const notFound = /not found/i.test(error.message);
    return c.json({ error: error.message }, notFound ? 404 : 400);
  });

  if (webRoot) {
    const webRoute = route("/*");
    app.use(
      webRoute,
      serveStatic({
        root: webRoot,
        rewriteRequestPath: (requestPath) =>
          prefix ? requestPath.slice(prefix.length) || "/" : requestPath,
      }),
    );
    app.get(webRoute, serveStatic({ path: `${webRoot}/index.html` }));
  }
  return app;
}
