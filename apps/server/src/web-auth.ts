import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppEnv } from "./api-auth.js";

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

/**
 * Verifies the app password. Browser sign-in and connector consent share one failure bucket,
 * so neither form can be used to brute-force the password faster than the other.
 */
export class PasswordGate {
  private readonly expected: Buffer;
  private readonly failures: number[] = [];

  constructor(
    password: string,
    private readonly now: () => number = Date.now,
  ) {
    this.expected = createHash("sha256").update(password).digest();
  }

  check(supplied: string): "ok" | "invalid" | "limited" {
    const valid = timingSafeEqual(createHash("sha256").update(supplied).digest(), this.expected);
    const threshold = this.now() - FAILED_LOGIN_WINDOW_MS;
    while (this.failures.length && this.failures[0]! <= threshold) this.failures.shift();
    // A shared failure bucket must never let unauthenticated callers lock out the owner.
    if (valid) {
      this.failures.length = 0;
      return "ok";
    }
    if (this.failures.length >= FAILED_LOGIN_LIMIT) return "limited";
    this.failures.push(this.now());
    return "invalid";
  }
}

export function installWebAuth(
  app: Hono<AppEnv>,
  prefix: string,
  gate: PasswordGate | undefined,
  options: WebAuthOptions = {},
  isPublicPath: (pathname: string) => boolean = () => false,
): void {
  if (!gate) return;

  const now = options.now ?? Date.now;
  const secureCookie = options.secureCookie ?? true;
  const cookieName = secureCookie ? COOKIE_NAME : DEV_COOKIE_NAME;
  const sessions = new Map<string, number>();
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
    if (
      c.get("apiClient") ||
      c.get("connectorClientId") ||
      pathname === healthPath ||
      pathname === loginPath ||
      isPublicPath(pathname)
    ) {
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
    const form = await readUrlEncodedForm(c.req.raw);
    if (!form) return c.json({ error: "Invalid sign-in request" }, 400);
    const nextPath = safeNext(form.get("next"), prefix, homePath);
    const result = gate.check(form.get("password") ?? "");
    if (result === "limited") {
      c.header("Retry-After", "60");
      return c.html(loginHtml(loginPath, nextPath, "Too many attempts. Try again shortly."), 429);
    }
    if (result === "invalid") {
      return c.html(loginHtml(loginPath, nextPath, "Incorrect password."), 401);
    }
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

export async function readUrlEncodedForm(request: Request): Promise<URLSearchParams | undefined> {
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

export function sameOrigin(
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

export function escapeHtml(value: string): string {
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

const AUTH_PAGE_CSS = [
  'body{margin:0;min-height:100vh;display:grid;place-items:center;background:#fff;color:#111;font:15px/1.5 Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-synthesis:none}',
  "main{width:min(360px,calc(100% - 40px));padding:32px 0}",
  "h1{margin:0 0 24px;font-size:44px;font-weight:650;letter-spacing:-.05em;line-height:1}",
  "h1 span{font-family:Georgia,serif;font-style:italic;font-weight:400}",
  "p{margin:0 0 16px;color:#777}",
  "label{display:block;margin:36px 0 4px;color:#777;font-size:11px;font-weight:700;letter-spacing:.16em;text-transform:uppercase}",
  "input{width:100%;box-sizing:border-box;padding:8px 0;border:0;border-bottom:1px solid #dedede;border-radius:0;background:transparent;font:inherit;outline:none;caret-color:#111;transition:border-color .2s}",
  "input:focus{border-color:#111}",
  "input[type=password]{font-size:22px;letter-spacing:.3em}",
  "button{width:100%;padding:13px;margin-top:28px;border:1px solid #111;background:#111;color:#fff;font:inherit;font-weight:600;cursor:pointer;transition:opacity .2s}",
  "button:hover{opacity:.85}",
  // Dim the primary action until something has been typed; the placeholder is a single space.
  "form:has(input:placeholder-shown) button:not(.secondary){opacity:.35}",
  "button.secondary{margin-top:10px;background:transparent;color:#111;border-color:#dedede}",
  ".error{padding-left:10px;border-left:2px solid #a00;color:#a00}",
  ".warning{color:#7a4b00}",
  "strong{color:#111}",
  "ul{color:#777;padding-left:20px}",
].join("");

/** Shared shell for the server-rendered sign-in and connector consent pages. */
export function authPageHtml(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} · uShelf</title><style>${AUTH_PAGE_CSS}</style></head><body><main><h1><span>u</span>Shelf</h1>${body}</main></body></html>`;
}

function loginHtml(action: string, nextPath: string, error?: string): string {
  return authPageHtml(
    "Sign in",
    `<p>Enter your password to open your library.</p>${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ""}<form method="post" action="${escapeHtml(action)}"><input type="hidden" name="next" value="${escapeHtml(nextPath)}"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" placeholder=" " required autofocus><button type="submit">Sign in</button></form>`,
  );
}
