import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ShelfService } from "@ushelf/core";
import { createUshelfMcpServer } from "./server.js";

const service = new ShelfService();
await service.initialize();

await createUshelfMcpServer(service).connect(new StdioServerTransport());
