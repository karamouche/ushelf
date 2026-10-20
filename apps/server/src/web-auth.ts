import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppEnv } from "./api-auth.js";
import { loginPageHtml } from "./auth-page.js";

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
 *
 * Once the bucket is full, every attempt is refused before the password is compared, including
 * the correct one: otherwise a "limited" answer would only mean "wrong password" and guessing
 * would stay unbounded. Existing browser sessions, API tokens, and connector tokens never pass
 * through the gate, so they keep working. The trade-off is that an attacker can delay new
 * sign-ins and connector approvals for up to one window.
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
    const threshold = this.now() - FAILED_LOGIN_WINDOW_MS;
    while (this.failures.length && this.failures[0]! <= threshold) this.failures.shift();
    if (this.failures.length >= FAILED_LOGIN_LIMIT) return "limited";
    const valid = timingSafeEqual(createHash("sha256").update(supplied).digest(), this.expected);
    if (valid) {
      this.failures.length = 0;
      return "ok";
    }
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
    return c.html(loginPageHtml(loginPath, nextPath));
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
      return c.html(
        loginPageHtml(loginPath, nextPath, "Too many attempts. Try again shortly."),
        429,
      );
    }
    if (result === "invalid") {
      return c.html(loginPageHtml(loginPath, nextPath, "Incorrect password."), 401);
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

const NEXT_BASE = "http://ushelf.invalid";
// Browsers strip tab, CR, and LF from URLs, so "/\t/evil.example" would become "//evil.example".
const UNSAFE_NEXT = /[\\\u0000-\u001f\u007f]/;

/** Returns a same-origin, normalized path below the base path, or the fallback. */
function safeNext(value: string | null | undefined, prefix: string, fallback: string): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || UNSAFE_NEXT.test(value)) {
    return fallback;
  }
  let resolved: URL;
  try {
    resolved = new URL(value, NEXT_BASE);
  } catch {
    return fallback;
  }
  if (resolved.origin !== NEXT_BASE) return fallback;
  const { pathname } = resolved;
  if (pathname.startsWith("//")) return fallback;
  if (prefix && pathname !== prefix && !pathname.startsWith(`${prefix}/`)) return fallback;
  return `${pathname}${resolved.search}${resolved.hash}`;
}
