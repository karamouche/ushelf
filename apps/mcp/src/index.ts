import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { ShelfService } from "@ushelf/core";
import { createUshelfMcpServer } from "./server.js";

const service = new ShelfService();
await service.initialize();

serveStdio(() => createUshelfMcpServer(service));
