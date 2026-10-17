import { describe, expect, it } from "vitest";
import type { ShelfService } from "@ushelf/core";
import { resolveApiToken } from "./api-auth.js";
import { createApp } from "./app.js";

const apiToken = "t".repeat(43);
const bearer = { authorization: `Bearer ${apiToken}` };
const mcpHeaders = {
  ...bearer,
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
};

function rpc(method: string, params: Record<string, unknown> = {}, id = 1) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

describe("API token authentication", () => {
  it("requires a strong token when one is configured", () => {
    expect(resolveApiToken(undefined)).toBeUndefined();
    expect(resolveApiToken("  ")).toBeUndefined();
    expect(() => resolveApiToken("short")).toThrow(/at least 32/);
    expect(resolveApiToken(apiToken)).toBe(apiToken);
  });

  it("rejects agent routes without a valid token, even when no password is set", async () => {
    const app = createApp({} as ShelfService, undefined, "/", { apiToken });
    for (const headers of [{}, { authorization: "Bearer wrong" }, { authorization: "Basic x" }]) {
      const response = await app.request("/mcp", { method: "POST", headers, body: "{}" });
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain("Bearer");
    }
    const unconfigured = createApp({} as ShelfService);
    expect((await unconfigured.request("/api/server", { headers: bearer })).status).toBe(401);
  });

  it("serves the MCP tool contract over stateless Streamable HTTP", async () => {
    const app = createApp({} as ShelfService, undefined, "/reader/", {
      apiToken,
      version: "1.2.3",
    });
    const initialize = await app.request("/reader/mcp", {
      method: "POST",
      headers: mcpHeaders,
      body: rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      }),
    });
    expect(initialize.status).toBe(200);
    expect(initialize.headers.get("mcp-session-id")).toBeNull();
    await expect(initialize.json()).resolves.toMatchObject({
      result: { serverInfo: { name: "ushelf", version: "1.2.3" } },
    });

    const tools = await app.request("/reader/mcp", {
      method: "POST",
      headers: { ...mcpHeaders, "mcp-protocol-version": "2025-06-18" },
      body: rpc("tools/list", {}, 2),
    });
    const names = ((await tools.json()) as { result: { tools: { name: string }[] } }).result.tools
      .map((tool) => tool.name)
      .sort();
    expect(names).toContain("ingest_url");
    expect(names).toContain("confirm_delete");
    expect(names).toContain("send_to_kindle");

    const notification = await app.request("/reader/mcp", {
      method: "POST",
      headers: mcpHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(notification.status).toBe(202);
    expect((await app.request("/reader/mcp", { headers: bearer })).status).toBe(405);
  });

  it("lets token clients bypass the browser session and origin checks", async () => {
    let listed = false;
    const service = {
      listItems: () => {
        listed = true;
        return [];
      },
    } as unknown as ShelfService;
    const app = createApp(service, undefined, "/", {
      apiToken,
      password: "correct horse battery staple",
      version: "1.2.3",
    });
    expect((await app.request("https://ushelf.example/api/items")).status).toBe(401);
    const items = await app.request("https://ushelf.example/api/items", { headers: bearer });
    expect(items.status).toBe(200);
    expect(listed).toBe(true);
    await expect(
      (await app.request("https://ushelf.example/api/server", { headers: bearer })).json(),
    ).resolves.toEqual({ version: "1.2.3" });
  });

  it("serves bundled skills only to token clients", async () => {
    const skills = [{ name: "ushelf-ingest", files: [{ path: "SKILL.md", content: "# x" }] }];
    const service = { agentSkills: async () => skills } as unknown as ShelfService;
    const app = createApp(service, undefined, "/", { apiToken, version: "1.2.3" });
    expect((await app.request("/api/agent/skills")).status).toBe(401);
    await expect(
      (await app.request("/api/agent/skills", { headers: bearer })).json(),
    ).resolves.toEqual({ version: "1.2.3", skills });
  });

  it("connects and disconnects Kindle only for token clients", async () => {
    const calls: unknown[] = [];
    const service = {
      connectKindle: async (credential: string) => {
        calls.push(credential);
        return { configured: true, accountName: "Reader" };
      },
      disconnectKindle: async (options: { deregister: boolean }) => {
        calls.push(options);
      },
    } as unknown as ShelfService;
    const app = createApp(service, undefined, "/", { apiToken });
    expect(
      (await app.request("/api/kindle/credential", { method: "PUT", body: "{}" })).status,
    ).toBe(401);
    const connected = await app.request("/api/kindle/credential", {
      method: "PUT",
      headers: bearer,
      body: '{"credential":true}',
    });
    await expect(connected.json()).resolves.toEqual({ configured: true, accountName: "Reader" });
    const oversized = await app.request("/api/kindle/credential", {
      method: "PUT",
      headers: { ...bearer, "content-length": String(64 * 1024 + 1) },
      body: "x".repeat(64 * 1024 + 1),
    });
    expect(oversized.status).toBe(413);
    expect(
      (await app.request("/api/kindle/credential", { method: "DELETE", headers: bearer })).status,
    ).toBe(400);
    const disconnected = await app.request("/api/kindle/credential?deregister=false", {
      method: "DELETE",
      headers: bearer,
    });
    await expect(disconnected.json()).resolves.toEqual({ disconnected: true });
    expect(calls).toEqual(['{"credential":true}', { deregister: false }]);
  });
});
