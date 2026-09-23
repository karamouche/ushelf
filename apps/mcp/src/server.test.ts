import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ShelfService } from "@ushelf/core";
import { afterEach, describe, expect, it } from "vitest";
import { createUshelfMcpServer, USHELF_MCP_INSTRUCTIONS } from "./server.js";

const openConnections: Array<{ client: Client; server: ReturnType<typeof createUshelfMcpServer> }> =
  [];

afterEach(async () => {
  await Promise.all(
    openConnections
      .splice(0)
      .map(({ client, server }) => Promise.all([client.close(), server.close()])),
  );
});

describe("uShelf MCP contract", () => {
  it("publishes one transport-independent, annotated capability set", async () => {
    const service = new Proxy({}, { get: () => async () => undefined }) as ShelfService;
    const server = createUshelfMcpServer(service);
    const client = new Client({ name: "contract-test", version: "test" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    openConnections.push({ client, server });

    expect(client.getInstructions()).toBe(USHELF_MCP_INSTRUCTIONS);
    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(17);
    expect(tools.tools.every(({ description, annotations }) => description && annotations)).toBe(
      true,
    );
    expect(tools.tools.find(({ name }) => name === "confirm_delete")?.annotations).toMatchObject({
      destructiveHint: true,
      readOnlyHint: false,
    });

    const resources = await client.listResourceTemplates();
    expect(resources.resourceTemplates.map(({ name }) => name)).toEqual([
      "item-source",
      "item-document",
      "recipe",
    ]);
  });
});
