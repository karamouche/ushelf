import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ShelfService } from "@ushelf/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpServer } from "./mcp-server.js";

const itemId = "123e4567-e89b-42d3-a456-426614174000";
const markdown = "Agent-supplied thread text that is long enough to be accepted.";
const openConnections: Array<{ client: Client; server: McpServer }> = [];

async function connect(service: Pick<ShelfService, "submitSourceContent">) {
  const server = createMcpServer(service as ShelfService, "test");
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

describe("submit_source_content", () => {
  it("rejects a title that is blank after trimming", async () => {
    const submitSourceContent = vi.fn();
    const client = await connect({ submitSourceContent });

    const result = await client.callTool({
      name: "submit_source_content",
      arguments: { itemId, title: " \n\t", markdown },
    });

    expect(result.isError).toBe(true);
    expect(submitSourceContent).not.toHaveBeenCalled();
  });

  it("passes the trimmed title to the service", async () => {
    const submitSourceContent = vi.fn(async () => ({ id: itemId }));
    const client = await connect({
      submitSourceContent,
    } as unknown as Pick<ShelfService, "submitSourceContent">);

    const result = await client.callTool({
      name: "submit_source_content",
      arguments: { itemId, title: "  A useful thread ", markdown },
    });

    expect(result.isError).not.toBe(true);
    expect(submitSourceContent).toHaveBeenCalledWith(
      expect.objectContaining({ title: "A useful thread" }),
    );
  });
});
