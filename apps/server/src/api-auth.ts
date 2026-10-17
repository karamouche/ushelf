import { createHash, timingSafeEqual } from "node:crypto";
import type { Hono } from "hono";
import { createMiddleware } from "hono/factory";

/**
 * `apiClient` marks requests carrying the owner's API token (CLI and local agents).
 * `connectorClientId` marks MCP requests carrying an OAuth access token issued to a connector.
 */
export type AppEnv = {
  Variables: { apiClient: boolean; connectorClientId: string | undefined };
};

const MIN_TOKEN_LENGTH = 32;
const CHALLENGE = 'Bearer realm="ushelf"';

/** Connector OAuth hooks; connector tokens are honored on the MCP endpoint only. */
export interface McpBearerAuth {
  path: string;
  /** OAuth endpoints that authenticate clients themselves, for example with HTTP Basic. */
  clientAuthenticatedPaths: ReadonlySet<string>;
  verifyAccessToken(token: string): { clientId: string } | undefined;
  challenge(request: Request, error?: "invalid_token"): string;
}

export function resolveApiToken(
  environmentValue = process.env.USHELF_API_TOKEN,
): string | undefined {
  const token = environmentValue?.trim();
  if (!token) return undefined;
  if (token.length < MIN_TOKEN_LENGTH || /\s/.test(token)) {
    throw new Error(`USHELF_API_TOKEN must be at least ${MIN_TOKEN_LENGTH} non-space characters`);
  }
  return token;
}

/**
 * Bearer tokens are not ambient browser credentials, so authenticated requests skip the
 * cookie session and same-origin checks. A present but invalid token is always rejected,
 * except on OAuth endpoints that authenticate clients with their own scheme.
 */
export function installApiTokenAuth(
  app: Hono<AppEnv>,
  token: string | undefined,
  mcp?: McpBearerAuth,
): void {
  const expected = token ? digest(token) : undefined;
  app.use("*", async (c, next) => {
    c.set("apiClient", false);
    c.set("connectorClientId", undefined);
    const header = c.req.header("authorization");
    const pathname = new URL(c.req.url).pathname;
    if (header === undefined || mcp?.clientAuthenticatedPaths.has(pathname)) {
      await next();
      return;
    }
    const supplied = /^Bearer ([^\s]+)$/i.exec(header)?.[1];
    if (expected && supplied && timingSafeEqual(digest(supplied), expected)) {
      c.set("apiClient", true);
      await next();
      return;
    }
    if (mcp && pathname === mcp.path) {
      const connector = supplied ? mcp.verifyAccessToken(supplied) : undefined;
      if (connector) {
        c.set("connectorClientId", connector.clientId);
        await next();
        return;
      }
      return c.json({ error: "Invalid access token" }, 401, {
        "WWW-Authenticate": mcp.challenge(c.req.raw, "invalid_token"),
      });
    }
    return c.json({ error: "Invalid API token" }, 401, { "WWW-Authenticate": CHALLENGE });
  });
}

export const requireApiToken = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.get("apiClient")) {
    return c.json({ error: "API token required" }, 401, { "WWW-Authenticate": CHALLENGE });
  }
  await next();
});

/** Accepts the owner's API token or, when connectors are enabled, a connector access token. */
export function requireMcpAccess(mcp: McpBearerAuth | undefined) {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (!c.get("apiClient") && !c.get("connectorClientId")) {
      return c.json({ error: "API token required" }, 401, {
        "WWW-Authenticate": mcp ? mcp.challenge(c.req.raw) : CHALLENGE,
      });
    }
    await next();
  });
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}
