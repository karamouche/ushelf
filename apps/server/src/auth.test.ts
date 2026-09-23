import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ShelfService } from "@ushelf/core";
import { createApp } from "./app.js";
import { createRemoteAuth, type RemoteAuth } from "./auth.js";
import { resolveServerRuntimeConfig } from "./runtime-config.js";

const roots: string[] = [];
const auths: RemoteAuth[] = [];
const publicUrl = new URL("https://shelf.example");

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ushelf-auth-"));
  roots.push(root);
  const auth = await createRemoteAuth({ authDir: path.join(root, "auth"), publicUrl });
  auths.push(auth);
  return { root, auth, app: createApp({} as ShelfService, undefined, "/", { auth, publicUrl }) };
}

afterEach(async () => {
  for (const auth of auths.splice(0)) auth.close();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("single-owner remote authentication", () => {
  it("requires a valid one-time claim and permanently disables signup", async () => {
    const { auth, app } = await fixture();
    expect(auth.claimCode).toHaveLength(32);

    const claim = await app.request("/api/setup/claim", {
      method: "POST",
      headers: { origin: publicUrl.origin, "content-type": "application/json" },
      body: JSON.stringify({
        code: auth.claimCode,
        email: "owner@example.com",
        password: "correct horse battery staple",
      }),
    });
    expect(claim.status).toBe(201);
    expect(auth.isClaimed()).toBe(true);

    const replay = await app.request("/api/setup/claim", {
      method: "POST",
      headers: { origin: publicUrl.origin, "content-type": "application/json" },
      body: JSON.stringify({
        code: auth.claimCode,
        email: "second@example.com",
        password: "another correct password",
      }),
    });
    expect(replay.status).toBe(400);
    expect(
      (
        await app.request("/api/auth/sign-up/email", {
          method: "POST",
          headers: { origin: publicUrl.origin, "content-type": "application/json" },
          body: JSON.stringify({
            email: "second@example.com",
            password: "another correct password",
            name: "Second",
          }),
        })
      ).status,
    ).toBe(404);
  });

  it("protects APIs, validates origins, signs in, and revokes sessions after reset", async () => {
    const { auth, app } = await fixture();
    await auth.claim({
      code: auth.claimCode!,
      email: "owner@example.com",
      password: "correct horse battery staple",
    });
    expect((await app.request("/api/items")).status).toBe(401);
    const health = await app.request("/api/health");
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ ok: true });
    expect((await app.request("/reset", { headers: { accept: "text/html" } })).status).not.toBe(
      302,
    );
    expect(
      (await app.request("/api/items", { headers: { "x-forwarded-host": "evil.example" } })).status,
    ).toBe(400);

    const login = await app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { origin: publicUrl.origin, "content-type": "application/json" },
      body: JSON.stringify({
        email: "owner@example.com",
        password: "correct horse battery staple",
      }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    expect((await app.request("/api/account", { headers: { cookie: cookie! } })).status).toBe(200);

    const reset = auth.issuePasswordReset();
    const resetResponse = await app.request("/api/recovery/reset", {
      method: "POST",
      headers: { origin: publicUrl.origin, "content-type": "application/json" },
      body: JSON.stringify({ code: reset.code, password: "a new correct password" }),
    });
    expect(resetResponse.status).toBe(200);
    expect((await app.request("/api/account", { headers: { cookie: cookie! } })).status).toBe(401);

    const replay = await app.request("/api/recovery/reset", {
      method: "POST",
      headers: { origin: publicUrl.origin, "content-type": "application/json" },
      body: JSON.stringify({ code: reset.code, password: "yet another password" }),
    });
    expect(replay.status).toBe(400);
    expect(
      (
        await app.request("/api/recovery/reset", {
          method: "POST",
          headers: { origin: "https://evil.example", "content-type": "application/json" },
          body: JSON.stringify({ code: "wrong", password: "yet another password" }),
        })
      ).status,
    ).toBe(400);
  });

  it("publishes OAuth discovery and challenges unauthenticated MCP requests", async () => {
    const { app } = await fixture();
    const resourceMetadata = await app.request("/.well-known/oauth-protected-resource/mcp");
    expect(resourceMetadata.status).toBe(200);
    await expect(resourceMetadata.json()).resolves.toMatchObject({
      resource: "https://shelf.example/mcp",
      authorization_servers: ["https://shelf.example/api/auth"],
      scopes_supported: ["ushelf:read", "ushelf:write", "ushelf:kindle"],
    });

    const authorizationMetadata = await app.request(
      "/api/auth/.well-known/oauth-authorization-server",
    );
    expect(authorizationMetadata.status).toBe(200);
    await expect(authorizationMetadata.json()).resolves.toMatchObject({
      issuer: "https://shelf.example/api/auth",
      code_challenge_methods_supported: ["S256"],
      grant_types_supported: expect.arrayContaining([
        "authorization_code",
        "refresh_token",
        "urn:ietf:params:oauth:grant-type:device_code",
      ]),
      device_authorization_endpoint: "https://shelf.example/api/auth/device/code",
    });

    const mcp = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(mcp.status).toBe(401);
    expect(mcp.headers.get("www-authenticate")).toContain(
      "https://shelf.example/.well-known/oauth-protected-resource/mcp",
    );
  });
});

describe("remote runtime configuration", () => {
  it("defaults to local and requires a root HTTPS origin remotely", () => {
    expect(resolveServerRuntimeConfig({ USHELF_ROOT: "/tmp/ushelf" }).mode).toBe("local");
    expect(() => resolveServerRuntimeConfig({ USHELF_MODE: "remote" })).toThrow(
      "USHELF_PUBLIC_URL",
    );
    expect(() =>
      resolveServerRuntimeConfig({ USHELF_MODE: "remote", USHELF_PUBLIC_URL: "http://bad.test" }),
    ).toThrow("HTTPS origin");
    expect(
      resolveServerRuntimeConfig({
        USHELF_MODE: "remote",
        USHELF_PUBLIC_URL: "https://shelf.example",
        USHELF_ROOT: "/data",
      }),
    ).toMatchObject({ mode: "remote", basePath: "/", authDir: "/data/auth" });
  });
});
