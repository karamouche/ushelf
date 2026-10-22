import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
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
import { z } from "zod";
import { installApiTokenAuth, requireApiToken, requireMcpAccess, type AppEnv } from "./api-auth.js";
import { createConnectorOAuth } from "./oauth.js";
import { installWebAuth, PasswordGate, type WebAuthOptions } from "./web-auth.js";

// Same bounds as the MCP list_items tool, with the reader's larger default page.
const pageLimitSchema = z.coerce.number().int().min(1).max(200).default(100);
const pageOffsetSchema = z.coerce.number().int().min(0).default(0);

// Attached PDFs are limited to 10 MiB before base64 encoding inside a JSON-RPC envelope.
const MCP_MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const KINDLE_CREDENTIAL_MAX_BYTES = 64 * 1024;
const JSON_BODY_MAX_BYTES = 16 * 1024;

// Requiring application/json forces a CORS preflight, so cross-site pages cannot send these writes.
const requireJsonBody = [
  createMiddleware<AppEnv>(async (c, next) => {
    const type = c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (type !== "application/json") {
      return c.json({ error: "Content-Type must be application/json" }, 415);
    }
    await next();
  }),
  bodyLimit({
    maxSize: JSON_BODY_MAX_BYTES,
    onError: (c) => c.json({ error: "Request body is too large" }, 413),
  }),
] as const;

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
  const passwordGate = options.password
    ? new PasswordGate(options.password, options.now)
    : undefined;
  // Connectors authenticate the owner with the app password, so OAuth needs one configured.
  const connectorOAuth = passwordGate
    ? createConnectorOAuth({
        prefix,
        connectors: service.connectors,
        passwordGate,
        secureCookie: options.secureCookie ?? true,
      })
    : undefined;
  installApiTokenAuth(app, options.apiToken, connectorOAuth);
  if (!passwordGate) installLoopbackHostGuard(app);
  installWebAuth(app, prefix, passwordGate, options, connectorOAuth?.isPublicPath);
  connectorOAuth?.install(app);
  const requireMcp = requireMcpAccess(connectorOAuth);

  // Each request gets a fresh stateless MCP server; all state lives in ShelfService.
  app.post(route("/mcp"), requireMcp, async (c) => {
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
  app.on(["GET", "DELETE"], route("/mcp"), requireMcp, (c) =>
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
  app.get(route("/api/connectors"), requireApiToken, (c) =>
    c.json({ connectors: service.connectors.list() }),
  );
  app.delete(route("/api/connectors"), requireApiToken, (c) =>
    c.json({ revoked: service.connectors.revokeAll() }),
  );
  app.delete(route("/api/connectors/:clientId"), requireApiToken, (c) =>
    service.connectors.revoke(c.req.param("clientId")!)
      ? c.json({ revoked: 1 })
      : c.json({ error: "Connector not found" }, 404),
  );
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
        limit: pageLimitSchema.parse(c.req.query("limit")),
        offset: pageOffsetSchema.parse(c.req.query("offset")),
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
  app.patch(route("/api/items/:id/reading"), ...requireJsonBody, async (c) => {
    const body = await c.req.json<{ status: string; progress: number; revision?: string }>();
    const item = await service.updateReading(
      c.req.param("id")!,
      readingStatusSchema.parse(body.status),
      Number(body.progress),
      body.revision,
    );
    return c.json({ item });
  });
  app.post(route("/api/items/:id/kindle-deliveries"), ...requireJsonBody, async (c) => {
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

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Without an app password the reader API is unauthenticated, so it may only be reached through a
 * loopback Host. This blocks DNS-rebinding pages; token clients stay allowed. It is not
 * authentication: other clients set their own Host, so startup refuses non-loopback exposure.
 */
function installLoopbackHostGuard(app: Hono<AppEnv>): void {
  app.use("*", async (c, next) => {
    if (c.get("apiClient") || isLoopbackHost(c.req.header("host") ?? new URL(c.req.url).host)) {
      await next();
      return;
    }
    return c.json(
      {
        error:
          "This uShelf server has no app password, so it only answers on localhost. Set USHELF_APP_PASSWORD to reach it through another host name.",
      },
      421,
    );
  });
}

function isLoopbackHost(host: string): boolean {
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
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
