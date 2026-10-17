import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { serveStatic } from "@hono/node-server/serve-static";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "@ushelf/mcp";
import {
  KindleError,
  kindleTargetSchema,
  readingStatusSchema,
  ShelfService,
  sourceTypeSchema,
} from "@ushelf/core";
import { readFileSync } from "node:fs";
import path from "node:path";
import { installApiTokenAuth, requireApiToken, type AppEnv } from "./api-auth.js";
import { installWebAuth, type WebAuthOptions } from "./web-auth.js";

// Attached PDFs are limited to 10 MiB before base64 encoding inside a JSON-RPC envelope.
const MCP_MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const KINDLE_CREDENTIAL_MAX_BYTES = 64 * 1024;

export interface AppOptions extends WebAuthOptions {
  apiToken?: string | undefined;
  version?: string;
}

export function createApp(
  service: ShelfService,
  webRoot?: string,
  basePath = "/",
  options: AppOptions = {},
) {
  const app = new Hono<AppEnv>();
  const normalizedBasePath = normalizeBasePath(basePath);
  const prefix = normalizedBasePath === "/" ? "" : normalizedBasePath.replace(/\/$/, "");
  const route = (path: string) => `${prefix}${path}`;
  const version = options.version ?? "dev";
  installApiTokenAuth(app, options.apiToken);
  installWebAuth(app, prefix, options);
  app.use(route("/api/*"), cors({ origin: ["http://127.0.0.1:43111", "http://localhost:43111"] }));

  // Each request gets a fresh stateless MCP server; all state lives in ShelfService.
  app.post(route("/mcp"), requireApiToken, async (c) => {
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
      maxRequestBodySize: MCP_MAX_REQUEST_BYTES,
    });
    const server = createMcpServer(service, version);
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      await server.close();
    }
  });
  app.on(["GET", "DELETE"], route("/mcp"), requireApiToken, (c) =>
    c.json({ error: "Method not allowed" }, 405, { Allow: "POST" }),
  );

  app.get(route("/api/health"), (c) =>
    c.json(options.password ? { ok: true, authRequired: true } : { ok: true }),
  );
  app.get(route("/api/server"), requireApiToken, (c) => c.json({ version }));
  app.get(route("/api/agent/skills"), requireApiToken, async (c) =>
    c.json({ version, skills: await service.agentSkills() }),
  );
  app.put(
    route("/api/kindle/credential"),
    requireApiToken,
    bodyLimit({
      maxSize: KINDLE_CREDENTIAL_MAX_BYTES,
      onError: (c) => c.json({ error: "Kindle credential is too large" }, 413),
    }),
    async (c) => c.json(await service.connectKindle(await c.req.text(), c.req.raw.signal)),
  );
  app.delete(route("/api/kindle/credential"), requireApiToken, async (c) => {
    const deregister = c.req.query("deregister");
    if (deregister !== "true" && deregister !== "false") {
      return c.json({ error: "deregister must be true or false" }, 400);
    }
    await service.disconnectKindle({ deregister: deregister === "true" }, c.req.raw.signal);
    return c.json({ disconnected: true });
  });
  app.get(route("/api/kindle/status"), async (c) =>
    c.json(await service.kindleStatus(c.req.raw.signal)),
  );
  app.get(route("/api/kindle/devices"), async (c) =>
    c.json(await service.kindleDevices(c.req.raw.signal)),
  );
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
  app.get(route("/api/items/:id/media/:filename"), async (c) => {
    const file = await service.getMediaFile(c.req.param("id")!, c.req.param("filename")!);
    return c.body(new Uint8Array(file.bytes), 200, {
      "content-type": file.mediaType,
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; sandbox",
      "x-content-type-options": "nosniff",
    });
  });
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
  app.post(route("/api/items/:id/kindle-deliveries"), async (c) => {
    const body = kindleTargetSchema.parse(await c.req.json());
    return c.json(
      await service.sendToKindle(c.req.param("id")!, body.targetSerial, c.req.raw.signal),
    );
  });
  app.get(route("/api/recipes"), async (c) => c.json({ recipes: await service.listRecipes() }));

  app.onError((error, c) => {
    console.error(error);
    if (error instanceof KindleError) {
      const body = { error: error.message, code: error.code };
      switch (error.code) {
        case "not_configured":
        case "already_configured":
        case "credential_invalid":
        case "delivery_in_progress":
          return c.json(body, 409);
        case "device_not_found":
          return c.json(body, 404);
        case "timeout":
          return c.json(body, 504);
        case "export_too_large":
          return c.json(body, 413);
        case "amazon_unavailable":
        case "bridge_unavailable":
        case "upload_rejected":
          return c.json(body, 503);
        default:
          return c.json(body, 400);
      }
    }
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
