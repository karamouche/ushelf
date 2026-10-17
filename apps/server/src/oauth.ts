import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { OAuthError, type ConnectorAuthorization, type ConnectorClient } from "@ushelf/core";
import { z } from "zod";
import type { AppEnv, McpBearerAuth } from "./api-auth.js";
import {
  authPageHtml,
  escapeHtml,
  readUrlEncodedForm,
  sameOrigin,
  type PasswordGate,
} from "./web-auth.js";

/**
 * OAuth 2.1 authorization server for remote MCP connectors (Claude, ChatGPT, and other
 * clients that implement the MCP authorization specification).
 *
 * Discovery follows RFC 9728 (protected resource metadata) and RFC 8414 (authorization
 * server metadata). Connectors register through RFC 7591 dynamic client registration, use the
 * authorization-code grant with S256 PKCE, and rotate refresh tokens. The library owner
 * approves each connector by entering the app password on the consent page.
 */

const SCOPE = "ushelf";
const REGISTRATION_MAX_BYTES = 16 * 1024;
const TOKEN_REQUEST_MAX_BYTES = 8 * 1024;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const registrationSchema = z.object({
  redirect_uris: z.array(z.string().max(2000)).min(1).max(10),
  client_name: z.string().max(1000).optional(),
  token_endpoint_auth_method: z
    .enum(["none", "client_secret_post", "client_secret_basic"])
    .optional(),
  grant_types: z.array(z.enum(["authorization_code", "refresh_token"])).optional(),
  response_types: z.array(z.literal("code")).optional(),
});

export interface ConnectorOAuth extends McpBearerAuth {
  isPublicPath(pathname: string): boolean;
  install(app: Hono<AppEnv>): void;
}

export function createConnectorOAuth(options: {
  prefix: string;
  connectors: ConnectorAuthorization;
  passwordGate: PasswordGate;
  secureCookie: boolean;
}): ConnectorOAuth {
  const { prefix, connectors, passwordGate, secureCookie } = options;
  const route = (path: string) => `${prefix}${path}`;
  const mcpPath = route("/mcp");
  const paths = {
    authorize: route("/oauth/authorize"),
    token: route("/oauth/token"),
    register: route("/oauth/register"),
    revoke: route("/oauth/revoke"),
  };
  // The challenge points at metadata under the base path so it stays reachable when a proxy
  // forwards only that path; the root RFC 9728/8414 locations are served for clients that probe.
  const resourceMetadataPaths = unique([
    route("/.well-known/oauth-protected-resource"),
    `/.well-known/oauth-protected-resource${mcpPath}`,
  ]);
  const authorizationServerMetadataPaths = unique([
    `/.well-known/oauth-authorization-server${prefix}`,
    route("/.well-known/oauth-authorization-server"),
    route("/.well-known/openid-configuration"),
  ]);
  // `/mcp` enforces bearer auth itself and must answer with the OAuth challenge, not the
  // browser sign-in response.
  const publicPaths = new Set([
    mcpPath,
    ...resourceMetadataPaths,
    ...authorizationServerMetadataPaths,
    ...Object.values(paths),
  ]);

  const issuer = (request: Request) => `${publicOrigin(request)}${prefix}`;
  const resource = (request: Request) => `${publicOrigin(request)}${mcpPath}`;

  const authorizationServerMetadata = (request: Request) => {
    const base = issuer(request);
    const authMethods = ["client_secret_basic", "client_secret_post", "none"];
    return {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      revocation_endpoint: `${base}/oauth/revoke`,
      scopes_supported: [SCOPE],
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: authMethods,
      revocation_endpoint_auth_methods_supported: authMethods,
      authorization_response_iss_parameter_supported: true,
    };
  };

  /** Validates an authorization request; returns where errors may safely be redirected. */
  const readAuthorizationRequest = (
    params: (name: string) => string | undefined,
    request: Request,
  ):
    | { kind: "fatal"; message: string }
    | { kind: "redirect-error"; redirectUri: string; error: string; message: string }
    | { kind: "ok"; value: AuthorizationRequest } => {
    const clientId = params("client_id") ?? "";
    const client = clientId ? connectors.client(clientId) : undefined;
    if (!client) {
      return { kind: "fatal", message: "This connector is not registered. Reconnect it." };
    }
    const requestedRedirect = params("redirect_uri");
    const redirectUri =
      requestedRedirect ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
    if (!redirectUri || !connectors.allowsRedirect(client, redirectUri)) {
      return { kind: "fatal", message: "The connector's redirect address is not registered." };
    }
    const state = params("state");
    const fail = (error: string, message: string) => ({
      kind: "redirect-error" as const,
      redirectUri: withParams(redirectUri, {
        error,
        error_description: message,
        ...(state === undefined ? {} : { state }),
        iss: issuer(request),
      }),
      error,
      message,
    });
    if (params("response_type") !== "code") {
      return fail("unsupported_response_type", "Only the authorization code flow is supported");
    }
    const codeChallenge = params("code_challenge");
    if (!codeChallenge || params("code_challenge_method") !== "S256") {
      return fail("invalid_request", "PKCE with code_challenge_method=S256 is required");
    }
    const requestedResource = params("resource");
    if (requestedResource !== undefined && !sameResource(requestedResource, resource(request))) {
      return fail("invalid_target", "The requested resource is not this uShelf server");
    }
    return {
      kind: "ok",
      value: {
        client,
        redirectUri,
        codeChallenge,
        ...(state === undefined ? {} : { state }),
        ...(requestedResource === undefined ? {} : { resource: requestedResource }),
      },
    };
  };

  return {
    path: mcpPath,
    clientAuthenticatedPaths: new Set([paths.token, paths.revoke]),
    verifyAccessToken: (token) => connectors.verifyAccessToken(token),
    challenge: (request, error) =>
      `Bearer realm="ushelf", resource_metadata="${publicOrigin(request)}${resourceMetadataPaths[0]}", scope="${SCOPE}"${
        error ? `, error="${error}"` : ""
      }`,
    isPublicPath: (pathname) => publicPaths.has(pathname),

    install(app) {
      // Metadata, registration, and token endpoints carry no ambient credentials, so browser
      // based MCP clients may call them from any origin.
      const openCors = cors({ origin: "*", allowHeaders: ["Authorization", "Content-Type"] });
      for (const path of [...resourceMetadataPaths, ...authorizationServerMetadataPaths]) {
        app.use(path, openCors);
      }
      for (const path of [paths.register, paths.token, paths.revoke]) app.use(path, openCors);

      for (const path of resourceMetadataPaths) {
        app.get(path, (c) =>
          c.json({
            resource: resource(c.req.raw),
            resource_name: "uShelf",
            authorization_servers: [issuer(c.req.raw)],
            scopes_supported: [SCOPE],
            bearer_methods_supported: ["header"],
          }),
        );
      }
      for (const path of authorizationServerMetadataPaths) {
        app.get(path, (c) => c.json(authorizationServerMetadata(c.req.raw)));
      }

      app.post(
        paths.register,
        bodyLimit({
          maxSize: REGISTRATION_MAX_BYTES,
          onError: (c) => oauthError(c, "invalid_client_metadata", "Registration is too large"),
        }),
        async (c) => {
          const parsed = registrationSchema.safeParse(await c.req.json().catch(() => undefined));
          if (!parsed.success) {
            const redirectIssue = parsed.error.issues.some(
              (issue) => issue.path[0] === "redirect_uris",
            );
            return oauthError(
              c,
              redirectIssue ? "invalid_redirect_uri" : "invalid_client_metadata",
              parsed.error.issues[0]?.message ?? "Invalid client metadata",
            );
          }
          try {
            const client = connectors.register({
              clientName: parsed.data.client_name,
              redirectUris: parsed.data.redirect_uris,
              tokenEndpointAuthMethod: parsed.data.token_endpoint_auth_method,
            });
            return c.json(
              {
                client_id: client.clientId,
                client_id_issued_at: client.clientIdIssuedAt,
                ...(client.clientSecret
                  ? { client_secret: client.clientSecret, client_secret_expires_at: 0 }
                  : {}),
                ...(client.clientName ? { client_name: client.clientName } : {}),
                redirect_uris: client.redirectUris,
                token_endpoint_auth_method: client.tokenEndpointAuthMethod,
                grant_types: ["authorization_code", "refresh_token"],
                response_types: ["code"],
                scope: SCOPE,
              },
              201,
            );
          } catch (error) {
            return handleOAuthError(c, error);
          }
        },
      );

      app.get(paths.authorize, (c) => {
        const parsed = readAuthorizationRequest((name) => c.req.query(name), c.req.raw);
        if (parsed.kind === "fatal") return consentError(c, parsed.message);
        if (parsed.kind === "redirect-error") return c.redirect(parsed.redirectUri, 303);
        return consentPage(c, paths.authorize, parsed.value);
      });

      app.post(paths.authorize, async (c) => {
        if (
          !sameOrigin(
            c.req.header("origin"),
            c.req.header("host") ?? new URL(c.req.url).host,
            secureCookie,
          ) ||
          !c.req.header("content-type")?.startsWith("application/x-www-form-urlencoded")
        ) {
          return consentError(c, "This approval request was not sent from the uShelf page.", 403);
        }
        const form = await readUrlEncodedForm(c.req.raw);
        if (!form) return consentError(c, "Invalid approval request.");
        const parsed = readAuthorizationRequest((name) => form.get(name) ?? undefined, c.req.raw);
        if (parsed.kind === "fatal") return consentError(c, parsed.message);
        if (parsed.kind === "redirect-error") return c.redirect(parsed.redirectUri, 303);
        const authorization = parsed.value;
        const back = (params: Record<string, string>) =>
          c.redirect(
            withParams(authorization.redirectUri, {
              ...params,
              ...(authorization.state === undefined ? {} : { state: authorization.state }),
              iss: issuer(c.req.raw),
            }),
            303,
          );
        if (form.get("decision") !== "allow") {
          return back({ error: "access_denied", error_description: "The owner denied access" });
        }
        const result = passwordGate.check(form.get("password") ?? "");
        if (result === "limited") {
          c.header("Retry-After", "60");
          return consentPage(
            c,
            paths.authorize,
            authorization,
            "Too many attempts. Try again shortly.",
            429,
          );
        }
        if (result === "invalid") {
          return consentPage(c, paths.authorize, authorization, "Incorrect password.", 401);
        }
        try {
          const code = connectors.issueCode({
            clientId: authorization.client.clientId,
            redirectUri: authorization.redirectUri,
            codeChallenge: authorization.codeChallenge,
          });
          return back({ code });
        } catch (error) {
          if (!(error instanceof OAuthError)) throw error;
          return back({ error: error.code, error_description: error.message });
        }
      });

      app.post(
        paths.token,
        bodyLimit({
          maxSize: TOKEN_REQUEST_MAX_BYTES,
          onError: (c) => oauthError(c, "invalid_request", "Token request is too large"),
        }),
        async (c) => {
          const form = await readTokenForm(c);
          if (!form) return oauthError(c, "invalid_request", "Expected a form-encoded body");
          const client = clientCredentials(c, form);
          if (!client) return oauthError(c, "invalid_request", "client_id is required");
          const requestedResource = form.get("resource");
          if (requestedResource !== null && !sameResource(requestedResource, resource(c.req.raw))) {
            return oauthError(c, "invalid_target", "The requested resource is not this server");
          }
          try {
            const grantType = form.get("grant_type");
            const tokens =
              grantType === "authorization_code"
                ? connectors.exchangeCode({
                    ...client,
                    code: form.get("code") ?? "",
                    redirectUri: form.get("redirect_uri") ?? "",
                    codeVerifier: form.get("code_verifier") ?? "",
                  })
                : grantType === "refresh_token"
                  ? connectors.refresh({ ...client, refreshToken: form.get("refresh_token") ?? "" })
                  : undefined;
            if (!tokens) {
              return oauthError(c, "unsupported_grant_type", "Unsupported grant_type");
            }
            c.header("Cache-Control", "no-store");
            c.header("Pragma", "no-cache");
            return c.json({
              access_token: tokens.accessToken,
              token_type: "Bearer",
              expires_in: tokens.expiresIn,
              refresh_token: tokens.refreshToken,
              scope: SCOPE,
            });
          } catch (error) {
            return handleOAuthError(c, error);
          }
        },
      );

      app.post(
        paths.revoke,
        bodyLimit({
          maxSize: TOKEN_REQUEST_MAX_BYTES,
          onError: (c) => oauthError(c, "invalid_request", "Revocation request is too large"),
        }),
        async (c) => {
          const form = await readTokenForm(c);
          if (!form) return oauthError(c, "invalid_request", "Expected a form-encoded body");
          const client = clientCredentials(c, form);
          if (!client) return oauthError(c, "invalid_request", "client_id is required");
          try {
            connectors.revokeToken(form.get("token") ?? "", client.clientId, client.clientSecret);
            return c.body(null, 200);
          } catch (error) {
            return handleOAuthError(c, error);
          }
        },
      );
    },
  };
}

interface AuthorizationRequest {
  client: ConnectorClient;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  resource?: string;
}

/**
 * Derives the externally visible origin. TLS usually terminates at a proxy (Caddy, Fly.io),
 * which reports the original scheme in X-Forwarded-Proto and preserves the Host header.
 */
export function publicOrigin(request: Request): string {
  const url = new URL(request.url);
  const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  const protocol =
    forwarded === "https" || forwarded === "http" ? forwarded : url.protocol.slice(0, -1);
  return `${protocol}://${url.host}`;
}

function sameResource(requested: string, expected: string): boolean {
  return requested.replace(/\/+$/, "") === expected;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function withParams(uri: string, params: Record<string, string>): string {
  const url = new URL(uri);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return url.toString();
}

async function readTokenForm(c: Context<AppEnv>): Promise<URLSearchParams | undefined> {
  if (!c.req.header("content-type")?.startsWith("application/x-www-form-urlencoded")) {
    return undefined;
  }
  return readUrlEncodedForm(c.req.raw);
}

/** Reads client credentials from HTTP Basic (RFC 6749 §2.3.1) or the form body. */
function clientCredentials(
  c: Context<AppEnv>,
  form: URLSearchParams,
): { clientId: string; clientSecret?: string } | undefined {
  const basic = /^Basic ([A-Za-z0-9+/=]+)$/i.exec(c.req.header("authorization") ?? "")?.[1];
  if (basic) {
    const decoded = Buffer.from(basic, "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator > 0) {
      return {
        clientId: decodeFormComponent(decoded.slice(0, separator)),
        clientSecret: decodeFormComponent(decoded.slice(separator + 1)),
      };
    }
  }
  const clientId = form.get("client_id");
  if (!clientId) return undefined;
  const clientSecret = form.get("client_secret");
  return { clientId, ...(clientSecret ? { clientSecret } : {}) };
}

function decodeFormComponent(value: string): string {
  try {
    return decodeURIComponent(value.replaceAll("+", " "));
  } catch {
    return value;
  }
}

function handleOAuthError(c: Context<AppEnv>, error: unknown) {
  if (!(error instanceof OAuthError)) throw error;
  return oauthError(c, error.code, error.message);
}

function oauthError(c: Context<AppEnv>, error: string, description: string) {
  const status = error === "invalid_client" ? 401 : error === "temporarily_unavailable" ? 503 : 400;
  c.header("Cache-Control", "no-store");
  return c.json({ error, error_description: description }, status);
}

/**
 * The approval POST must keep a real Origin header for the same-origin check, so the policy
 * cannot be `no-referrer` (browsers then send `Origin: null`). `same-origin` still keeps the
 * consent URL out of the Referer sent to the app. There is no `form-action` directive because
 * Chrome applies it to every hop of the post-approval redirect, which the app may extend.
 */
function consentHeaders(c: Context<AppEnv>) {
  c.header(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  );
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "same-origin");
}

function consentError(c: Context<AppEnv>, message: string, status: 400 | 403 = 400) {
  consentHeaders(c);
  return c.html(
    authPageHtml(
      "Connection failed",
      `<p class="error" role="alert">${escapeHtml(message)}</p><p>Start the connection again from your AI app.</p>`,
    ),
    status,
  );
}

function consentPage(
  c: Context<AppEnv>,
  action: string,
  request: AuthorizationRequest,
  error?: string,
  status: 200 | 401 | 429 = 200,
) {
  consentHeaders(c);
  const redirect = new URL(request.redirectUri);
  const loopback = LOOPBACK_HOSTS.has(redirect.hostname);
  const name = request.client.clientName ?? "An unnamed app";
  const hidden = {
    client_id: request.client.clientId,
    redirect_uri: request.redirectUri,
    response_type: "code",
    code_challenge: request.codeChallenge,
    code_challenge_method: "S256",
    ...(request.state === undefined ? {} : { state: request.state }),
    ...(request.resource === undefined ? {} : { resource: request.resource }),
  };
  const fields = Object.entries(hidden)
    .map(([field, value]) => `<input type="hidden" name="${field}" value="${escapeHtml(value)}">`)
    .join("");
  return c.html(
    authPageHtml(
      "Connect an app",
      `<p><strong>${escapeHtml(name)}</strong> wants to connect to your library and will return to <strong>${escapeHtml(redirect.host)}</strong>.</p>` +
        `<p>Once connected it can search, read, save, edit, and delete items, and send them to Kindle, until you revoke it with <code>ushelf connectors revoke</code>.</p>` +
        (loopback
          ? `<p class="warning">This app runs on a computer, not a hosted service. Continue only if you started this connection yourself.</p>`
          : "") +
        (error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : "") +
        `<form method="post" action="${escapeHtml(action)}">${fields}` +
        `<label for="password">uShelf password</label><input id="password" name="password" type="password" autocomplete="current-password" autofocus>` +
        `<button type="submit" name="decision" value="allow">Allow access</button>` +
        `<button type="submit" name="decision" value="deny" class="secondary">Deny</button></form>`,
    ),
    status,
  );
}
