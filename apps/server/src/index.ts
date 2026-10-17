import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { ShelfService } from "@ushelf/core";
import { createApp } from "./app.js";
import { resolveApiToken } from "./api-auth.js";

const service = new ShelfService();
await service.initialize();

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot =
  process.env.NODE_ENV === "production" ? path.resolve(here, "../../web/dist") : undefined;
const port = Number(process.env.USHELF_PORT ?? 43110);
const hostname = process.env.USHELF_HOST ?? "127.0.0.1";
const basePath = process.env.USHELF_WEB_BASE_PATH?.trim() || "/";
// Release builds pin USHELF_VERSION; otherwise report the manifest version the release process sets.
const packageVersion = (
  JSON.parse(readFileSync(path.resolve(here, "../package.json"), "utf8")) as { version: string }
).version;
const version = process.env.USHELF_VERSION?.trim() || packageVersion;

serve(
  {
    fetch: createApp(service, webRoot, basePath, {
      password: process.env.USHELF_APP_PASSWORD || undefined,
      apiToken: resolveApiToken(),
      secureCookie: process.env.NODE_ENV !== "development",
      version,
    }).fetch,
    port,
    hostname,
  },
  (info) => {
    console.log(`uShelf is reading at http://${hostname}:${info.port}`);
  },
);
