import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { KindleError, type ShelfService } from "@ushelf/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerKindleTools } from "./kindle-tools.js";

const itemId = "123e4567-e89b-42d3-a456-426614174000";
const openConnections: Array<{ client: Client; server: McpServer }> = [];

async function connect(service: Pick<ShelfService, "kindleDevices" | "sendToKindle">) {
  const server = new McpServer({ name: "ushelf-test", version: "test" });
  registerKindleTools(server, service);
  const client = new Client({ name: "ushelf-test-client", version: "test" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  openConnections.push({ client, server });
  return client;
}

afterEach(async () => {
  await Promise.all(
    openConnections
      .splice(0)
      .map(({ client, server }) => Promise.all([client.close(), server.close()])),
  );
});

describe("Kindle MCP tools", () => {
  it("lists devices and exposes delivery as an external side effect", async () => {
    const kindleDevices = vi.fn(async () => ({
      devices: [{ name: "Paperwhite", serial: "DEVICE123" }],
      preferredTargetSerial: "DEVICE123",
    }));
    const client = await connect({
      kindleDevices,
      sendToKindle: vi.fn(),
    } as unknown as Pick<ShelfService, "kindleDevices" | "sendToKindle">);

    const tools = await client.listTools();
    expect(tools.tools.map(({ name }) => name)).toEqual(["list_kindle_devices", "send_to_kindle"]);
    expect(tools.tools.find(({ name }) => name === "send_to_kindle")?.annotations).toMatchObject({
      readOnlyHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });

    const result = await client.callTool({ name: "list_kindle_devices", arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      devices: [{ name: "Paperwhite", serial: "DEVICE123" }],
      preferredTargetSerial: "DEVICE123",
    });
    expect(kindleDevices).toHaveBeenCalledOnce();
  });

  it("sends a saved item to the selected device", async () => {
    const sendToKindle = vi.fn(async () => ({
      sku: "sku-1",
      itemId,
      revision: "a".repeat(64),
      targetSerial: "DEVICE123",
    }));
    const client = await connect({
      kindleDevices: vi.fn(),
      sendToKindle,
    } as unknown as Pick<ShelfService, "kindleDevices" | "sendToKindle">);

    const result = await client.callTool({
      name: "send_to_kindle",
      arguments: { itemId, targetSerial: " DEVICE123 " },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ sku: "sku-1", itemId });
    expect(sendToKindle).toHaveBeenCalledWith(itemId, "DEVICE123", expect.any(AbortSignal));
  });

  it("returns stable structured Kindle errors", async () => {
    const client = await connect({
      kindleDevices: vi.fn(async () => {
        throw new KindleError("not_configured", "Run `ushelf kindle setup` to connect Kindle.");
      }),
      sendToKindle: vi.fn(async () => {
        throw new KindleError("device_not_found", "The selected Kindle device was not found.");
      }),
    } as unknown as Pick<ShelfService, "kindleDevices" | "sendToKindle">);

    const devicesResult = await client.callTool({
      name: "list_kindle_devices",
      arguments: {},
    });
    expect(devicesResult.isError).toBe(true);
    expect(devicesResult.structuredContent).toEqual({
      code: "not_configured",
      error: "Run `ushelf kindle setup` to connect Kindle.",
    });

    const deliveryResult = await client.callTool({
      name: "send_to_kindle",
      arguments: { itemId, targetSerial: "MISSING" },
    });
    expect(deliveryResult.isError).toBe(true);
    expect(deliveryResult.structuredContent).toEqual({
      code: "device_not_found",
      error: "The selected Kindle device was not found.",
    });
  });

  it("rejects invalid item IDs before calling Core", async () => {
    const sendToKindle = vi.fn();
    const client = await connect({
      kindleDevices: vi.fn(),
      sendToKindle,
    } as unknown as Pick<ShelfService, "kindleDevices" | "sendToKindle">);

    const result = await client.callTool({
      name: "send_to_kindle",
      arguments: { itemId: "not-a-uuid", targetSerial: "DEVICE123" },
    });
    expect(result.isError).toBe(true);
    expect(sendToKindle).not.toHaveBeenCalled();
  });
});
