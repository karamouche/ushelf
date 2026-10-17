import { createHash, timingSafeEqual } from "node:crypto";
import type { Hono } from "hono";
import { createMiddleware } from "hono/factory";

/** Requests carrying a valid API token act for the library owner's CLI and agents. */
export type AppEnv = { Variables: { apiClient: boolean } };

const MIN_TOKEN_LENGTH = 32;
const CHALLENGE = { "WWW-Authenticate": 'Bearer realm="ushelf"' };

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
 * cookie session and same-origin checks. A present but invalid token is always rejected.
 */
export function installApiTokenAuth(app: Hono<AppEnv>, token: string | undefined): void {
  const expected = token ? digest(token) : undefined;
  app.use("*", async (c, next) => {
    const header = c.req.header("authorization");
    if (header === undefined) {
      c.set("apiClient", false);
      await next();
      return;
    }
    const supplied = /^Bearer ([^\s]+)$/i.exec(header)?.[1];
    if (!expected || !supplied || !timingSafeEqual(digest(supplied), expected)) {
      return c.json({ error: "Invalid API token" }, 401, CHALLENGE);
    }
    c.set("apiClient", true);
    await next();
  });
}

export const requireApiToken = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.get("apiClient")) return c.json({ error: "API token required" }, 401, CHALLENGE);
  await next();
});

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}
