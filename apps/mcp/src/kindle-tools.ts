import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { KindleError, kindleTargetSchema, type ShelfService } from "@ushelf/core";
import { z } from "zod";

type KindleService = Pick<ShelfService, "kindleDevices" | "sendToKindle">;

const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: value as Record<string, unknown>,
});

const kindleResult = async (operation: () => Promise<unknown>) => {
  try {
    return json(await operation());
  } catch (error) {
    if (!(error instanceof KindleError)) throw error;
    return {
      ...json({ code: error.code, error: error.message }),
      isError: true as const,
    };
  }
};

export function registerKindleTools(server: McpServer, service: KindleService): void {
  server.registerTool(
    "list_kindle_devices",
    {
      title: "List Kindle devices",
      description:
        "List registered Kindle devices and the last successfully used device, when available.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (_input, { signal }) => kindleResult(() => service.kindleDevices(signal)),
  );

  server.registerTool(
    "send_to_kindle",
    {
      title: "Send to Kindle",
      description:
        "Send an already-saved item's canonical source and local images to a registered Kindle device as an EPUB. Generated insights are excluded.",
      inputSchema: {
        itemId: z.uuid(),
        targetSerial: kindleTargetSchema.shape.targetSerial,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ itemId, targetSerial }, { signal }) =>
      kindleResult(() => service.sendToKindle(itemId, targetSerial, signal)),
  );
}
