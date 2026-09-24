import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

const COOKIE_NAME = "__Host-ushelf-session";
const DEV_COOKIE_NAME = "ushelf-session";
const SESSION_MS = 12 * 60 * 60 * 1000;
const FAILED_LOGIN_LIMIT = 10;
const FAILED_LOGIN_WINDOW_MS = 60 * 1000;

export interface WebAuthOptions {
  password?: string | undefined;
  secureCookie?: boolean;
  now?: () => number;
}

export function installWebAuth(app: Hono, prefix: string, options: WebAuthOptions = {}): void {
  const password = options.password ?? "";
  if (!password) return;

  const now = options.now ?? Date.now;
  const secureCookie = options.secureCookie ?? true;
  const cookieName = secureCookie ? COOKIE_NAME : DEV_COOKIE_NAME;
  const expected = createHash("sha256").update(password).digest();
  const sessions = new Map<string, number>();
  const failures: number[] = [];
  const route = (path: string) => `${prefix}${path}`;
  const loginPath = route("/auth/login");
  const logoutPath = route("/api/auth/logout");
  const healthPath = route("/api/health");
  const homePath = route("/");

  const authenticated = (cookie: string | undefined): boolean => {
    if (!cookie) return false;
    const expires = sessions.get(cookie);
    if (expires === undefined) return false;
    if (expires <= now()) {
      sessions.delete(cookie);
      return false;
    }
    return true;
  };

  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    const pathname = new URL(c.req.url).pathname;
    if (pathname === loginPath) {
      c.header(
        "Content-Security-Policy",
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      );
    }
    if (pathname === healthPath || pathname === loginPath) {
      await next();
      return;
    }
    const session = getCookie(c, cookieName);
    if (!authenticated(session)) {
      if (c.req.method === "GET" && !pathname.startsWith(route("/api/"))) {
        const nextPath = `${pathname}${new URL(c.req.url).search}`;
        return c.redirect(`${loginPath}?next=${encodeURIComponent(nextPath)}`, 303);
      }
      return c.json({ error: "Sign in required" }, 401);
    }
    if (
      !isSafeMethod(c.req.method) &&
      !sameOrigin(
        c.req.header("origin"),
        c.req.header("host") ?? new URL(c.req.url).host,
        secureCookie,
      )
    ) {
      return c.json({ error: "Invalid request origin" }, 403);
    }
    await next();
  });

  app.get(loginPath, (c) => {
    const nextPath = safeNext(c.req.query("next"), prefix, homePath);
    if (authenticated(getCookie(c, cookieName))) return c.redirect(nextPath, 303);
    return c.html(loginHtml(loginPath, nextPath));
  });

  app.post(loginPath, async (c) => {
    if (
      !sameOrigin(
        c.req.header("origin"),
        c.req.header("host") ?? new URL(c.req.url).host,
        secureCookie,
      )
    ) {
      return c.json({ error: "Invalid request origin" }, 403);
    }
    if (!c.req.header("content-type")?.startsWith("application/x-www-form-urlencoded")) {
      return c.json({ error: "Invalid sign-in request" }, 400);
    }
    const form = await readLoginForm(c.req.raw);
    if (!form) return c.json({ error: "Invalid sign-in request" }, 400);
    const nextPath = safeNext(form.get("next"), prefix, homePath);
    const supplied = createHash("sha256")
      .update(form.get("password") ?? "")
      .digest();
    const validPassword = timingSafeEqual(supplied, expected);
    const threshold = now() - FAILED_LOGIN_WINDOW_MS;
    while (failures.length && failures[0]! <= threshold) failures.shift();
    // A shared failure bucket must never let unauthenticated callers lock out the owner.
    if (!validPassword) {
      if (failures.length >= FAILED_LOGIN_LIMIT) {
        c.header("Retry-After", "60");
        return c.html(loginHtml(loginPath, nextPath, "Too many attempts. Try again shortly."), 429);
      }
      failures.push(now());
      return c.html(loginHtml(loginPath, nextPath, "Incorrect password."), 401);
    }
    failures.length = 0;
    for (const [token, expires] of sessions) if (expires <= now()) sessions.delete(token);
    const token = randomBytes(32).toString("base64url");
    sessions.set(token, now() + SESSION_MS);
    setCookie(c, cookieName, token, {
      path: "/",
      httpOnly: true,
      secure: secureCookie,
      sameSite: "Strict",
      maxAge: SESSION_MS / 1000,
    });
    return c.redirect(nextPath, 303);
  });

  app.post(logoutPath, (c) => {
    const token = getCookie(c, cookieName);
    if (token) sessions.delete(token);
    deleteCookie(c, cookieName, { path: "/", secure: secureCookie });
    return c.json({ ok: true });
  });
}

function isSafeMethod(method: string): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

async function readLoginForm(request: Request): Promise<URLSearchParams | undefined> {
  const reader = request.body?.getReader();
  if (!reader) return new URLSearchParams();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 8192) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function sameOrigin(
  origin: string | undefined,
  host: string | undefined,
  secureCookie: boolean,
): boolean {
  if (!origin || !host) return false;
  try {
    const parsed = new URL(origin);
    return (
      (parsed.protocol === "https:" || (!secureCookie && parsed.protocol === "http:")) &&
      parsed.host === host
    );
  } catch {
    return false;
  }
}

function safeNext(value: string | null | undefined, prefix: string, fallback: string): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return fallback;
  }
  const pathname = new URL(value, "http://localhost").pathname;
  if (prefix && pathname !== prefix && !pathname.startsWith(`${prefix}/`)) return fallback;
  return value;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function loginHtml(action: string, nextPath: string, error?: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in · uShelf</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f7f6f2;color:#111;font:16px system-ui,sans-serif}main{width:min(360px,calc(100% - 40px))}h1{font:normal 48px Georgia,serif;margin:0 0 12px}p{color:#555}label{display:block;margin:32px 0 8px}input{width:100%;box-sizing:border-box;padding:13px;font:inherit;border:1px solid #aaa;background:white}button{width:100%;padding:13px;margin-top:16px;border:0;background:#111;color:white;font:inherit;cursor:pointer}.error{color:#a00}</style></head><body><main><h1>uShelf</h1><p>Enter your password to open your library.</p>${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ""}<form method="post" action="${escapeHtml(action)}"><input type="hidden" name="next" value="${escapeHtml(nextPath)}"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required autofocus><button type="submit">Sign in</button></form></main></body></html>`;
}
