import { createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import { createUshelfMcpServer } from "@ushelf/mcp";
import type { ShelfService } from "@ushelf/core";
import type { RemoteAuth } from "./auth.js";

const WRITE_TOOLS = new Set([
  "ingest_url",
  "ingest_file",
  "submit_source_content",
  "save_insights",
  "update_reading_state",
  "refresh_source",
  "request_reenrichment",
  "request_delete",
  "confirm_delete",
]);
const KINDLE_TOOLS = new Set(["list_kindle_devices", "send_to_kindle"]);

export function createHttpMcpHandler(service: ShelfService, remoteAuth: RemoteAuth) {
  const mcpHandler = createMcpHandler(() => createUshelfMcpServer(service), {
    legacy: "reject",
    responseMode: "auto",
    onerror: (error) => console.error("MCP request failed", error),
  });

  return remoteAuth.protectMcp(async (request, claims) => {
    const scopes = parseScopes(claims.scope);
    const requiredScope = await requestScope(request);
    if (requiredScope && !scopes.includes(requiredScope)) {
      return new Response(
        JSON.stringify({
          error: "insufficient_scope",
          error_description: `Missing ${requiredScope}`,
        }),
        {
          status: 403,
          headers: {
            "content-type": "application/json",
            "www-authenticate": `Bearer error="insufficient_scope", scope="${requiredScope}"`,
          },
        },
      );
    }
    const authorization = request.headers.get("authorization") ?? "";
    const authInfo: AuthInfo = {
      token: authorization.replace(/^Bearer\s+/i, ""),
      clientId: String(claims.client_id ?? claims.sub ?? "unknown"),
      scopes,
      ...(typeof claims.exp === "number" ? { expiresAt: claims.exp } : {}),
    };
    return mcpHandler.fetch(request, { authInfo });
  });
}

async function requestScope(request: Request): Promise<string | undefined> {
  if (request.method !== "POST") return undefined;
  const body = (await request
    .clone()
    .json()
    .catch(() => undefined)) as { method?: string; params?: { name?: string } } | undefined;
  if (body?.method?.startsWith("resources/")) return "ushelf:read";
  if (body?.method !== "tools/call" || !body.params?.name) return undefined;
  if (KINDLE_TOOLS.has(body.params.name)) return "ushelf:kindle";
  return WRITE_TOOLS.has(body.params.name) ? "ushelf:write" : "ushelf:read";
}

function parseScopes(value: unknown): string[] {
  if (Array.isArray(value))
    return value.filter((scope): scope is string => typeof scope === "string");
  return typeof value === "string" ? value.split(/\s+/).filter(Boolean) : [];
}
