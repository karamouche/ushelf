import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveConfig, ShelfService } from "@ushelf/core";
import { createApp } from "./app.js";

const ORIGIN = "https://ushelf.example";
const PASSWORD = "correct horse battery staple";
const API_TOKEN = "t".repeat(43);
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "v".repeat(64);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
const roots: string[] = [];

afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

async function fixture(basePath = "/", now?: () => number) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ushelf-oauth-test-"));
  roots.push(root);
  const service = new ShelfService(resolveConfig(root));
  const app = createApp(service, undefined, basePath, {
    apiToken: API_TOKEN,
    password: PASSWORD,
    version: "1.2.3",
    ...(now ? { now } : {}),
  });
  const prefix = basePath === "/" ? "" : basePath.replace(/\/$/, "");
  const request = (pathname: string, init?: RequestInit) =>
    app.request(`${ORIGIN}${prefix}${pathname}`, init);
  return { app, service, prefix, request };
}

function form(values: Record<string, string>) {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN },
    body: new URLSearchParams(values).toString(),
  };
}

function mcpRequest(token: string) {
  return {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      },
    }),
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function register(request: Fixture["request"], body: Record<string, unknown> = {}) {
  const response = await request("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Claude",
      redirect_uris: [CALLBACK],
      token_endpoint_auth_method: "client_secret_post",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      ...body,
    }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { client_id: string; client_secret?: string };
}

function authorizeParams(clientId: string, extra: Record<string, string> = {}) {
  return {
    client_id: clientId,
    redirect_uri: CALLBACK,
    response_type: "code",
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    state: "opaque-state",
    resource: `${ORIGIN}/mcp`,
    ...extra,
  };
}

/** Runs discovery, registration, consent, and code exchange the way Claude does. */
async function connect(fixture: Fixture) {
  const { request } = fixture;
  const client = await register(request);
  const approval = await request(
    "/oauth/authorize",
    form({ ...authorizeParams(client.client_id), password: PASSWORD, decision: "allow" }),
  );
  expect(approval.status).toBe(303);
  const redirect = new URL(approval.headers.get("location")!);
  expect(`${redirect.origin}${redirect.pathname}`).toBe(CALLBACK);
  expect(redirect.searchParams.get("state")).toBe("opaque-state");
  expect(redirect.searchParams.get("iss")).toBe(`${ORIGIN}${fixture.prefix}`);
  const exchanged = await request(
    "/oauth/token",
    form({
      grant_type: "authorization_code",
      code: redirect.searchParams.get("code")!,
      redirect_uri: CALLBACK,
      code_verifier: VERIFIER,
      client_id: client.client_id,
      client_secret: client.client_secret!,
      resource: `${ORIGIN}${fixture.prefix}/mcp`,
    }),
  );
  expect(exchanged.status).toBe(200);
  const tokens = (await exchanged.json()) as {
    access_token: string;
    refresh_token: string;
    token_type: string;
    expires_in: number;
  };
  return { client, tokens };
}

describe("connector OAuth", () => {
  it("points unauthenticated MCP requests at protected resource metadata", async () => {
    const { request } = await fixture();
    const response = await request("/mcp", { method: "POST", body: "{}" });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer realm="ushelf", resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource", scope="ushelf"`,
    );

    for (const pathname of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      const metadata = await request(pathname);
      expect(metadata.status).toBe(200);
      await expect(metadata.json()).resolves.toMatchObject({
        resource: `${ORIGIN}/mcp`,
        authorization_servers: [ORIGIN],
      });
    }
    const server = await request("/.well-known/oauth-authorization-server");
    await expect(server.json()).resolves.toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/oauth/authorize`,
      token_endpoint: `${ORIGIN}/oauth/token`,
      registration_endpoint: `${ORIGIN}/oauth/register`,
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: expect.arrayContaining(["none", "client_secret_post"]),
    });
    expect(server.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("derives public URLs from the proxy and the configured base path", async () => {
    const { app } = await fixture("/reader/");
    const response = await app.request("http://internal:43110/reader/mcp", {
      method: "POST",
      headers: { "x-forwarded-proto": "https" },
    });
    expect(response.headers.get("www-authenticate")).toContain(
      'resource_metadata="https://internal:43110/reader/.well-known/oauth-protected-resource"',
    );
    for (const pathname of [
      "/.well-known/oauth-protected-resource/reader/mcp",
      "/reader/.well-known/oauth-protected-resource",
    ]) {
      await expect((await app.request(`${ORIGIN}${pathname}`)).json()).resolves.toMatchObject({
        resource: `${ORIGIN}/reader/mcp`,
        authorization_servers: [`${ORIGIN}/reader`],
      });
    }
    for (const pathname of [
      "/.well-known/oauth-authorization-server/reader",
      "/reader/.well-known/oauth-authorization-server",
      "/reader/.well-known/openid-configuration",
    ]) {
      await expect((await app.request(`${ORIGIN}${pathname}`)).json()).resolves.toMatchObject({
        issuer: `${ORIGIN}/reader`,
        token_endpoint: `${ORIGIN}/reader/oauth/token`,
      });
    }
  });

  it("connects a confidential client end to end and serves MCP with its access token", async () => {
    const context = await fixture();
    const { tokens } = await connect(context);
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.expires_in).toBe(3600);

    const initialize = await context.request("/mcp", mcpRequest(tokens.access_token));
    expect(initialize.status).toBe(200);
    await expect(initialize.json()).resolves.toMatchObject({
      result: { serverInfo: { name: "ushelf" } },
    });
  });

  it("supports base paths and public clients with HTTP Basic-free token requests", async () => {
    const context = await fixture("/reader/");
    const client = await register(context.request, {
      token_endpoint_auth_method: "none",
      redirect_uris: ["http://localhost/callback"],
    });
    expect(client.client_secret).toBeUndefined();
    const consent = await context.request(
      `/oauth/authorize?${new URLSearchParams(
        authorizeParams(client.client_id, {
          redirect_uri: "http://localhost:3118/callback",
          resource: `${ORIGIN}/reader/mcp`,
        }),
      )}`,
    );
    expect(consent.status).toBe(200);
    const html = await consent.text();
    expect(html).toContain("localhost:3118");
    expect(html).toContain("Continue only if you started this connection yourself");
    // `no-referrer` would make browsers send `Origin: null` on the approval POST, which the
    // same-origin check rejects; `form-action` would block redirect hops after the callback.
    expect(consent.headers.get("referrer-policy")).toBe("same-origin");
    expect(consent.headers.get("content-security-policy")).not.toContain("form-action");

    const approval = await context.request(
      "/oauth/authorize",
      form({
        ...authorizeParams(client.client_id, {
          redirect_uri: "http://localhost:3118/callback",
          resource: `${ORIGIN}/reader/mcp`,
        }),
        password: PASSWORD,
        decision: "allow",
      }),
    );
    const code = new URL(approval.headers.get("location")!).searchParams.get("code")!;
    const exchanged = await context.request(
      "/oauth/token",
      form({
        grant_type: "authorization_code",
        code,
        redirect_uri: "http://localhost:3118/callback",
        code_verifier: VERIFIER,
        client_id: client.client_id,
      }),
    );
    expect(exchanged.status).toBe(200);
    const { access_token } = (await exchanged.json()) as { access_token: string };
    expect((await context.request("/mcp", mcpRequest(access_token))).status).toBe(200);
  });

  it("accepts client_secret_basic and rotates refresh tokens", async () => {
    const context = await fixture();
    const { client, tokens } = await connect(context);
    const basic = Buffer.from(`${client.client_id}:${client.client_secret}`).toString("base64");
    const refresh = (refreshToken: string) =>
      context.request("/oauth/token", {
        method: "POST",
        headers: {
          authorization: `Basic ${basic}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }).toString(),
      });

    const refreshed = await refresh(tokens.refresh_token);
    expect(refreshed.status).toBe(200);
    const rotated = (await refreshed.json()) as { access_token: string };
    expect((await context.request("/mcp", mcpRequest(tokens.access_token))).status).toBe(401);
    expect((await context.request("/mcp", mcpRequest(rotated.access_token))).status).toBe(200);

    const replayed = await refresh(tokens.refresh_token);
    expect(replayed.status).toBe(400);
    await expect(replayed.json()).resolves.toMatchObject({ error: "invalid_grant" });
    const revoked = await context.request("/mcp", mcpRequest(rotated.access_token));
    expect(revoked.status).toBe(401);
    expect(revoked.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("requires the app password and honors denial", async () => {
    const { request } = await fixture();
    const client = await register(request);
    const params = authorizeParams(client.client_id);

    const wrong = await request(
      "/oauth/authorize",
      form({ ...params, password: "nope", decision: "allow" }),
    );
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toContain("Incorrect password.");

    const denied = await request("/oauth/authorize", form({ ...params, decision: "deny" }));
    expect(denied.status).toBe(303);
    const location = new URL(denied.headers.get("location")!);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe("opaque-state");

    const crossSite = await request("/oauth/authorize", {
      ...form({ ...params, password: PASSWORD, decision: "allow" }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://attacker.example",
      },
    });
    expect(crossSite.status).toBe(403);
  });

  it("refuses consent, even with the correct password, while sign-ins are rate limited", async () => {
    let clock = 1_000_000;
    const { request } = await fixture("/", () => clock);
    const client = await register(request);
    const params = authorizeParams(client.client_id);
    // Browser sign-in failures fill the same bucket the consent page checks.
    for (let count = 0; count < 10; count++) {
      const failed = await request("/auth/login", form({ password: "wrong" }));
      expect(failed.status).toBe(401);
    }
    const limited = await request(
      "/oauth/authorize",
      form({ ...params, password: PASSWORD, decision: "allow" }),
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(limited.headers.get("location")).toBeNull();
    expect(await limited.text()).toContain("Too many attempts.");

    clock += 60_001;
    const approved = await request(
      "/oauth/authorize",
      form({ ...params, password: PASSWORD, decision: "allow" }),
    );
    expect(approved.status).toBe(303);
    expect(new URL(approved.headers.get("location")!).searchParams.get("code")).toBeTruthy();
  });

  it("never redirects to unregistered addresses and rejects other resources", async () => {
    const { request } = await fixture();
    const client = await register(request);
    const unregistered = await request(
      `/oauth/authorize?${new URLSearchParams(
        authorizeParams(client.client_id, { redirect_uri: "https://attacker.example/cb" }),
      )}`,
    );
    expect(unregistered.status).toBe(400);
    expect(unregistered.headers.get("location")).toBeNull();

    const unknownClient = await request(
      `/oauth/authorize?${new URLSearchParams(authorizeParams("missing"))}`,
    );
    expect(unknownClient.status).toBe(400);

    const otherResource = await request(
      `/oauth/authorize?${new URLSearchParams(
        authorizeParams(client.client_id, { resource: "https://elsewhere.example/mcp" }),
      )}`,
    );
    expect(otherResource.status).toBe(303);
    expect(new URL(otherResource.headers.get("location")!).searchParams.get("error")).toBe(
      "invalid_target",
    );

    const noPkce = await request(
      `/oauth/authorize?${new URLSearchParams(
        authorizeParams(client.client_id, { code_challenge_method: "plain" }),
      )}`,
    );
    expect(new URL(noPkce.headers.get("location")!).searchParams.get("error")).toBe(
      "invalid_request",
    );
  });

  it("rejects invalid registrations with RFC 7591 errors", async () => {
    const { request } = await fixture();
    const insecure = await request("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://example.com/callback"] }),
    });
    expect(insecure.status).toBe(400);
    await expect(insecure.json()).resolves.toMatchObject({ error: "invalid_redirect_uri" });

    const implicit = await request("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [CALLBACK], grant_types: ["implicit"] }),
    });
    await expect(implicit.json()).resolves.toMatchObject({ error: "invalid_client_metadata" });
  });

  it("keeps connector tokens off every route except MCP", async () => {
    const context = await fixture();
    const { tokens } = await connect(context);
    const bearer = { authorization: `Bearer ${tokens.access_token}` };
    for (const pathname of ["/api/items", "/api/server", "/api/connectors"]) {
      expect((await context.request(pathname, { headers: bearer })).status).toBe(401);
    }
  });

  it("lists and revokes connectors only for API token clients", async () => {
    const context = await fixture();
    const { client, tokens } = await connect(context);
    const owner = { authorization: `Bearer ${API_TOKEN}` };
    expect((await context.request("/api/connectors")).status).toBe(401);

    const listed = await context.request("/api/connectors", { headers: owner });
    await expect(listed.json()).resolves.toEqual({
      connectors: [
        expect.objectContaining({
          clientId: client.client_id,
          clientName: "Claude",
          redirectUris: [CALLBACK],
        }),
      ],
    });
    const revoked = await context.request(`/api/connectors/${client.client_id}`, {
      method: "DELETE",
      headers: owner,
    });
    await expect(revoked.json()).resolves.toEqual({ revoked: 1 });
    expect((await context.request("/mcp", mcpRequest(tokens.access_token))).status).toBe(401);
    expect(
      (
        await context.request(`/api/connectors/${client.client_id}`, {
          method: "DELETE",
          headers: owner,
        })
      ).status,
    ).toBe(404);

    await connect(context);
    const all = await context.request("/api/connectors", { method: "DELETE", headers: owner });
    await expect(all.json()).resolves.toEqual({ revoked: 1 });
  });

  it("is disabled without an app password", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ushelf-oauth-test-"));
    roots.push(root);
    const app = createApp(new ShelfService(resolveConfig(root)), undefined, "/", {
      apiToken: API_TOKEN,
    });
    const response = await app.request("/mcp", { method: "POST", body: "{}" });
    expect(response.headers.get("www-authenticate")).toBe('Bearer realm="ushelf"');
    expect((await app.request("/.well-known/oauth-protected-resource")).status).toBe(404);
  });
});
