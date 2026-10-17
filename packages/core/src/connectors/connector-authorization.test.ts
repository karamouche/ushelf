import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ShelfDatabase } from "../persistence/sqlite/shelf-database.js";
import {
  ACCESS_TOKEN_TTL_MS,
  AUTHORIZATION_CODE_TTL_MS,
  ConnectorAuthorization,
  OAuthError,
  REFRESH_TOKEN_TTL_MS,
} from "./connector-authorization.js";

const roots: string[] = [];
const databases: ShelfDatabase[] = [];
const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "a".repeat(64);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ushelf-connectors-test-"));
  roots.push(root);
  const database = new ShelfDatabase(path.join(root, "state", "ushelf.db"));
  databases.push(database);
  const clock = { now: Date.parse("2026-10-17T12:00:00.000Z") };
  return { clock, connectors: new ConnectorAuthorization(database, () => clock.now) };
}

function connect(connectors: ConnectorAuthorization, redirectUri = CLAUDE_CALLBACK) {
  const client = connectors.register({
    clientName: "Claude",
    redirectUris: [redirectUri],
    tokenEndpointAuthMethod: "client_secret_post",
  });
  const code = connectors.issueCode({
    clientId: client.clientId,
    redirectUri,
    codeChallenge: CHALLENGE,
  });
  const tokens = connectors.exchangeCode({
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    code,
    redirectUri,
    codeVerifier: VERIFIER,
  });
  return { client, tokens };
}

function oauthCode(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    if (error instanceof OAuthError) return error.code;
    throw error;
  }
  return undefined;
}

describe("ConnectorAuthorization", () => {
  it("completes an authorization-code grant with PKCE and verifies the access token", async () => {
    const { connectors } = await fixture();
    const { client, tokens } = connect(connectors);

    expect(client.clientSecret).toBeDefined();
    expect(tokens.expiresIn).toBe(ACCESS_TOKEN_TTL_MS / 1000);
    expect(connectors.verifyAccessToken(tokens.accessToken)).toEqual({
      clientId: client.clientId,
    });
    expect(connectors.verifyAccessToken(tokens.refreshToken)).toBeUndefined();
    expect(connectors.list()).toEqual([
      expect.objectContaining({ clientId: client.clientId, clientName: "Claude" }),
    ]);
  });

  it("registers public clients without a secret", async () => {
    const { connectors } = await fixture();
    const client = connectors.register({
      redirectUris: ["http://127.0.0.1/callback"],
      tokenEndpointAuthMethod: "none",
    });
    expect(client.clientSecret).toBeUndefined();
    expect(client.tokenEndpointAuthMethod).toBe("none");
  });

  it("rejects insecure redirect URIs at registration", async () => {
    const { connectors } = await fixture();
    for (const uri of [
      "http://example.com/callback",
      "https://claude.ai/callback#fragment",
      "javascript:alert(1)",
      "not a url",
    ]) {
      expect(oauthCode(() => connectors.register({ redirectUris: [uri] }))).toBe(
        "invalid_redirect_uri",
      );
    }
    expect(oauthCode(() => connectors.register({ redirectUris: [] }))).toBe("invalid_redirect_uri");
  });

  it("matches loopback redirects on any port but other redirects exactly", async () => {
    const { connectors } = await fixture();
    const loopback = connectors.register({ redirectUris: ["http://localhost/callback"] });
    const hosted = connectors.register({ redirectUris: [CLAUDE_CALLBACK] });

    expect(connectors.allowsRedirect(loopback, "http://localhost:3118/callback")).toBe(true);
    expect(connectors.allowsRedirect(loopback, "http://localhost:3118/other")).toBe(false);
    expect(connectors.allowsRedirect(loopback, "http://127.0.0.1:3118/callback")).toBe(false);
    expect(connectors.allowsRedirect(hosted, CLAUDE_CALLBACK)).toBe(true);
    expect(connectors.allowsRedirect(hosted, "https://claude.ai:8443/api/mcp/auth_callback")).toBe(
      false,
    );
    expect(
      oauthCode(() =>
        connectors.issueCode({
          clientId: hosted.clientId,
          redirectUri: "https://attacker.example/callback",
          codeChallenge: CHALLENGE,
        }),
      ),
    ).toBe("invalid_request");
  });

  it("rejects a wrong PKCE verifier, reused codes, and expired codes", async () => {
    const { clock, connectors } = await fixture();
    const client = connectors.register({
      redirectUris: [CLAUDE_CALLBACK],
      tokenEndpointAuthMethod: "none",
    });
    const issue = () =>
      connectors.issueCode({
        clientId: client.clientId,
        redirectUri: CLAUDE_CALLBACK,
        codeChallenge: CHALLENGE,
      });
    const exchange =
      (code: string, codeVerifier = VERIFIER) =>
      () =>
        connectors.exchangeCode({
          clientId: client.clientId,
          code,
          redirectUri: CLAUDE_CALLBACK,
          codeVerifier,
        });

    const wrongVerifier = issue();
    expect(oauthCode(exchange(wrongVerifier, "b".repeat(64)))).toBe("invalid_grant");
    // A failed exchange still consumes the code.
    expect(oauthCode(exchange(wrongVerifier))).toBe("invalid_grant");

    const reused = issue();
    expect(oauthCode(exchange(reused))).toBeUndefined();
    expect(oauthCode(exchange(reused))).toBe("invalid_grant");

    const expired = issue();
    clock.now += AUTHORIZATION_CODE_TTL_MS;
    expect(oauthCode(exchange(expired))).toBe("invalid_grant");
  });

  it("requires the registered client secret for confidential clients", async () => {
    const { connectors } = await fixture();
    const { client, tokens } = connect(connectors);
    expect(
      oauthCode(() =>
        connectors.refresh({ clientId: client.clientId, refreshToken: tokens.refreshToken }),
      ),
    ).toBe("invalid_client");
    expect(
      oauthCode(() =>
        connectors.refresh({
          clientId: client.clientId,
          clientSecret: "wrong",
          refreshToken: tokens.refreshToken,
        }),
      ),
    ).toBe("invalid_client");
  });

  it("rotates refresh tokens and revokes the grant when a rotated token is replayed", async () => {
    const { connectors } = await fixture();
    const { client, tokens } = connect(connectors);
    const refresh = (refreshToken: string) =>
      connectors.refresh({
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        refreshToken,
      });

    const rotated = refresh(tokens.refreshToken);
    expect(rotated.refreshToken).not.toBe(tokens.refreshToken);
    expect(connectors.verifyAccessToken(tokens.accessToken)).toBeUndefined();
    expect(connectors.verifyAccessToken(rotated.accessToken)).toBeDefined();

    expect(oauthCode(() => refresh(tokens.refreshToken))).toBe("invalid_grant");
    expect(connectors.verifyAccessToken(rotated.accessToken)).toBeUndefined();
    expect(oauthCode(() => refresh(rotated.refreshToken))).toBe("invalid_grant");
    expect(connectors.list()).toEqual([]);
  });

  it("expires access and refresh tokens", async () => {
    const { clock, connectors } = await fixture();
    const { client, tokens } = connect(connectors);
    clock.now += ACCESS_TOKEN_TTL_MS;
    expect(connectors.verifyAccessToken(tokens.accessToken)).toBeUndefined();
    clock.now += REFRESH_TOKEN_TTL_MS;
    expect(
      oauthCode(() =>
        connectors.refresh({
          clientId: client.clientId,
          clientSecret: client.clientSecret,
          refreshToken: tokens.refreshToken,
        }),
      ),
    ).toBe("invalid_grant");
  });

  it("revokes individual tokens, single connectors, and all connectors", async () => {
    const { connectors } = await fixture();
    const first = connect(connectors);
    connectors.revokeToken(
      first.tokens.refreshToken,
      first.client.clientId,
      first.client.clientSecret,
    );
    expect(connectors.verifyAccessToken(first.tokens.accessToken)).toBeUndefined();

    const second = connect(connectors);
    expect(connectors.revoke(second.client.clientId)).toBe(true);
    expect(connectors.verifyAccessToken(second.tokens.accessToken)).toBeUndefined();
    expect(connectors.client(second.client.clientId)).toBeUndefined();
    expect(connectors.revoke(second.client.clientId)).toBe(false);

    const third = connect(connectors);
    const fourth = connect(connectors);
    expect(connectors.revokeAll()).toBe(2);
    expect(connectors.verifyAccessToken(third.tokens.accessToken)).toBeUndefined();
    expect(connectors.verifyAccessToken(fourth.tokens.accessToken)).toBeUndefined();
  });

  it("purges abandoned registrations before enforcing the client limit", async () => {
    const { clock, connectors } = await fixture();
    for (let index = 0; index < 100; index++) {
      connectors.register({ redirectUris: [CLAUDE_CALLBACK] });
    }
    expect(oauthCode(() => connectors.register({ redirectUris: [CLAUDE_CALLBACK] }))).toBe(
      "temporarily_unavailable",
    );
    clock.now += 25 * 60 * 60_000;
    expect(
      oauthCode(() => connectors.register({ redirectUris: [CLAUDE_CALLBACK] })),
    ).toBeUndefined();
  });
});
