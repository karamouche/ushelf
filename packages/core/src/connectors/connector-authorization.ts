import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { ShelfDatabase } from "../persistence/sqlite/shelf-database.js";

/**
 * OAuth 2.1 authorization for remote MCP connectors such as Claude and ChatGPT.
 *
 * The library owner approves each connector once; the connector then holds a short-lived
 * access token for `/mcp` and a rotating refresh token. Only SHA-256 digests of codes and
 * tokens are stored. Adapters own HTTP parsing, the consent screen, and owner sign-in.
 */

export const ACCESS_TOKEN_TTL_MS = 60 * 60_000;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60_000;
export const AUTHORIZATION_CODE_TTL_MS = 2 * 60_000;
const ABANDONED_REGISTRATION_MS = 24 * 60 * 60_000;
const LAST_USED_RESOLUTION_MS = 5 * 60_000;
const MAX_CLIENTS = 100;
const MAX_REDIRECT_URIS = 10;
const MAX_REDIRECT_URI_LENGTH = 2000;
const MAX_CLIENT_NAME_LENGTH = 200;
const ACCESS_TOKEN_PREFIX = "ushelf_at_";
const REFRESH_TOKEN_PREFIX = "ushelf_rt_";

export type ConnectorAuthMethod = "none" | "client_secret_post" | "client_secret_basic";

export type OAuthErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "invalid_redirect_uri"
  | "invalid_client_metadata"
  | "temporarily_unavailable";

/** Carries an RFC 6749/7591 error code so adapters can return the standard error body. */
export class OAuthError extends Error {
  constructor(
    readonly code: OAuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OAuthError";
  }
}

export interface ConnectorRegistration {
  clientId: string;
  clientSecret?: string;
  clientName?: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: ConnectorAuthMethod;
  clientIdIssuedAt: number;
}

export interface ConnectorClient {
  clientId: string;
  clientName?: string;
  redirectUris: string[];
}

export interface ConnectorTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface Connector {
  clientId: string;
  clientName?: string;
  redirectUris: string[];
  connectedAt: string;
  lastUsedAt: string;
}

export class ConnectorAuthorization {
  constructor(
    private readonly database: ShelfDatabase,
    private readonly now: () => number = Date.now,
  ) {}

  register(input: {
    clientName?: string | undefined;
    redirectUris: string[];
    tokenEndpointAuthMethod?: ConnectorAuthMethod | undefined;
  }): ConnectorRegistration {
    if (!input.redirectUris.length || input.redirectUris.length > MAX_REDIRECT_URIS) {
      throw new OAuthError(
        "invalid_redirect_uri",
        `Register between 1 and ${MAX_REDIRECT_URIS} redirect URIs`,
      );
    }
    for (const uri of input.redirectUris) assertRedirectUri(uri);
    const clientName = input.clientName?.trim().slice(0, MAX_CLIENT_NAME_LENGTH) || undefined;
    const method = input.tokenEndpointAuthMethod ?? "client_secret_basic";
    const now = this.now();
    this.database.purgeOAuth(now, now - ABANDONED_REGISTRATION_MS);
    // Registration is unauthenticated, so make room by dropping the oldest unapproved client
    // rather than refusing: otherwise anyone could fill the table and lock the owner out.
    if (
      this.database.oauthClientCount() >= MAX_CLIENTS &&
      !this.database.deleteOldestUnapprovedOAuthClient()
    ) {
      throw new OAuthError(
        "temporarily_unavailable",
        "Too many connectors are connected; revoke unused ones with `ushelf connectors revoke`",
      );
    }
    const clientId = randomUUID();
    const clientSecret = method === "none" ? undefined : randomToken();
    this.database.insertOAuthClient({
      clientId,
      clientSecretHash: clientSecret ? digest(clientSecret) : null,
      clientName: clientName ?? null,
      redirectUris: input.redirectUris,
      createdAt: now,
    });
    return {
      clientId,
      ...(clientSecret ? { clientSecret } : {}),
      ...(clientName ? { clientName } : {}),
      redirectUris: input.redirectUris,
      tokenEndpointAuthMethod: method,
      clientIdIssuedAt: Math.floor(now / 1000),
    };
  }

  /** Returns a registered client so an adapter can render consent; never its secret. */
  client(clientId: string): ConnectorClient | undefined {
    const row = this.database.oauthClient(clientId);
    if (!row) return undefined;
    return {
      clientId: row.clientId,
      ...(row.clientName ? { clientName: row.clientName } : {}),
      redirectUris: row.redirectUris,
    };
  }

  /** True when the redirect URI was registered, matching loopback URIs on any port (RFC 8252). */
  allowsRedirect(client: ConnectorClient, redirectUri: string): boolean {
    return client.redirectUris.some((registered) => redirectMatches(registered, redirectUri));
  }

  /** Issues a single-use code after the library owner approved the connector. */
  issueCode(input: { clientId: string; redirectUri: string; codeChallenge: string }): string {
    const client = this.client(input.clientId);
    if (!client) throw new OAuthError("invalid_client", "Unknown client");
    if (!this.allowsRedirect(client, input.redirectUri)) {
      throw new OAuthError("invalid_request", "redirect_uri is not registered for this client");
    }
    if (!/^[A-Za-z0-9_-]{43}$/.test(input.codeChallenge)) {
      throw new OAuthError("invalid_request", "code_challenge must be an S256 PKCE challenge");
    }
    const code = randomToken();
    this.database.insertAuthorizationCode({
      codeHash: digest(code),
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      expiresAt: this.now() + AUTHORIZATION_CODE_TTL_MS,
    });
    return code;
  }

  exchangeCode(input: {
    clientId: string;
    clientSecret?: string | undefined;
    code: string;
    redirectUri: string;
    codeVerifier: string;
  }): ConnectorTokens {
    this.authenticateClient(input.clientId, input.clientSecret);
    const code = this.database.consumeAuthorizationCode(digest(input.code));
    if (
      !code ||
      code.expiresAt <= this.now() ||
      code.clientId !== input.clientId ||
      code.redirectUri !== input.redirectUri ||
      !/^[A-Za-z0-9._~-]{43,128}$/.test(input.codeVerifier) ||
      !safeEqual(pkceChallenge(input.codeVerifier), code.codeChallenge)
    ) {
      throw new OAuthError("invalid_grant", "Authorization code is invalid or expired");
    }
    const now = this.now();
    const tokens = newTokens();
    this.database.insertOAuthGrant({
      id: randomUUID(),
      clientId: input.clientId,
      accessTokenHash: digest(tokens.accessToken),
      accessExpiresAt: now + ACCESS_TOKEN_TTL_MS,
      refreshTokenHash: digest(tokens.refreshToken),
      refreshExpiresAt: now + REFRESH_TOKEN_TTL_MS,
      createdAt: now,
      lastUsedAt: now,
    });
    return tokens;
  }

  /**
   * Rotates the refresh token. Presenting a refresh token that was already rotated out means
   * it leaked or was replayed, so the whole grant is revoked.
   */
  refresh(input: {
    clientId: string;
    clientSecret?: string | undefined;
    refreshToken: string;
  }): ConnectorTokens {
    this.authenticateClient(input.clientId, input.clientSecret);
    const presented = digest(input.refreshToken);
    const grant = this.database.oauthGrantByRefreshToken(presented);
    const now = this.now();
    if (!grant || grant.clientId !== input.clientId || grant.refreshExpiresAt <= now) {
      throw new OAuthError("invalid_grant", "Refresh token is invalid or expired");
    }
    if (grant.replayed) {
      this.database.deleteOAuthGrant(grant.id);
      throw new OAuthError("invalid_grant", "Refresh token was already used; reconnect");
    }
    const tokens = newTokens();
    const rotated = this.database.rotateOAuthGrant(grant.id, presented, {
      accessTokenHash: digest(tokens.accessToken),
      accessExpiresAt: now + ACCESS_TOKEN_TTL_MS,
      refreshTokenHash: digest(tokens.refreshToken),
      refreshExpiresAt: now + REFRESH_TOKEN_TTL_MS,
      lastUsedAt: now,
    });
    if (!rotated) throw new OAuthError("invalid_grant", "Refresh token was already used");
    return tokens;
  }

  /** Resolves a bearer access token to the connector it was issued to. */
  verifyAccessToken(token: string): { clientId: string } | undefined {
    if (!token.startsWith(ACCESS_TOKEN_PREFIX)) return undefined;
    const grant = this.database.oauthGrantByAccessToken(digest(token));
    const now = this.now();
    if (!grant || grant.accessExpiresAt <= now) return undefined;
    if (now - grant.lastUsedAt >= LAST_USED_RESOLUTION_MS) {
      this.database.touchOAuthGrant(grant.id, now);
    }
    return { clientId: grant.clientId };
  }

  /** RFC 7009 revocation: revoking either token ends the grant. Unknown tokens are ignored. */
  revokeToken(token: string, clientId: string, clientSecret?: string): void {
    this.authenticateClient(clientId, clientSecret);
    const hash = digest(token);
    const grant =
      this.database.oauthGrantByAccessToken(hash) ?? this.database.oauthGrantByRefreshToken(hash);
    if (grant?.clientId === clientId) this.database.deleteOAuthGrant(grant.id);
  }

  list(): Connector[] {
    this.database.purgeOAuth(this.now(), this.now() - ABANDONED_REGISTRATION_MS);
    return this.database.oauthConnectors().map((row) => ({
      clientId: row.clientId,
      ...(row.clientName ? { clientName: row.clientName } : {}),
      redirectUris: row.redirectUris,
      connectedAt: new Date(row.connectedAt).toISOString(),
      lastUsedAt: new Date(row.lastUsedAt).toISOString(),
    }));
  }

  /** Deletes the client registration together with its codes and grants. */
  revoke(clientId: string): boolean {
    return this.database.deleteOAuthClient(clientId);
  }

  revokeAll(): number {
    const connected = this.list().length;
    this.database.deleteAllOAuthClients();
    return connected;
  }

  private authenticateClient(clientId: string, clientSecret: string | undefined): void {
    const client = this.database.oauthClient(clientId);
    if (!client) throw new OAuthError("invalid_client", "Unknown client");
    if (!client.clientSecretHash) return;
    if (!clientSecret || !safeEqual(digest(clientSecret), client.clientSecretHash)) {
      throw new OAuthError("invalid_client", "Client authentication failed");
    }
  }
}

function newTokens(): ConnectorTokens {
  return {
    accessToken: `${ACCESS_TOKEN_PREFIX}${randomToken()}`,
    refreshToken: `${REFRESH_TOKEN_PREFIX}${randomToken()}`,
    expiresIn: ACCESS_TOKEN_TTL_MS / 1000,
  };
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Redirects must be HTTPS, or HTTP on a loopback host for native clients (RFC 8252). */
function assertRedirectUri(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OAuthError("invalid_redirect_uri", `Invalid redirect URI: ${value.slice(0, 200)}`);
  }
  const secure =
    url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
  if (
    value.length > MAX_REDIRECT_URI_LENGTH ||
    !secure ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new OAuthError(
      "invalid_redirect_uri",
      "Redirect URIs must use HTTPS (or HTTP on a loopback address) without credentials or fragments",
    );
  }
}

function redirectMatches(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  let expected: URL;
  let actual: URL;
  try {
    expected = new URL(registered);
    actual = new URL(requested);
  } catch {
    return false;
  }
  return (
    expected.protocol === "http:" &&
    LOOPBACK_HOSTS.has(expected.hostname) &&
    actual.protocol === "http:" &&
    actual.hostname === expected.hostname &&
    actual.pathname === expected.pathname &&
    actual.search === expected.search &&
    !actual.hash &&
    !actual.username &&
    !actual.password
  );
}
