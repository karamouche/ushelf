import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "../../server/node_modules/@hono/node-server/dist/index.mjs";
import { createApp } from "../../server/dist/app.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "../dist");
const service = {
  listItems: () => [],
  getItem: async () => {
    throw new Error("Item was not found");
  },
};
const app = createApp(service, webRoot, "/", {
  password: process.env.USHELF_WEB_PASSWORD,
  secureCookie: false,
});

serve({ fetch: app.fetch, hostname: "127.0.0.1", port: Number(process.env.USHELF_PORT) });
