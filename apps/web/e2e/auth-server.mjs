import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "../../server/node_modules/@hono/node-server/dist/index.mjs";
import { resolveConfig, ShelfService } from "../../../packages/core/dist/index.js";
import { createApp } from "../../server/dist/app.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "../dist");
// Connector OAuth needs real grant storage; the library itself stays stubbed.
const shelf = new ShelfService(resolveConfig(mkdtempSync(path.join(os.tmpdir(), "ushelf-e2e-"))));
const service = {
  connectors: shelf.connectors,
  listItems: () => [],
  getItem: async () => {
    throw new Error("Item was not found");
  },
};
const app = createApp(service, webRoot, "/", {
  password: process.env.USHELF_APP_PASSWORD,
  secureCookie: false,
});

serve({ fetch: app.fetch, hostname: "127.0.0.1", port: Number(process.env.USHELF_PORT) });
