import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { ShelfService } from "@ushelf/core";
import { createApp } from "./app.js";
import { createRemoteAuth } from "./auth.js";
import { resolveServerRuntimeConfig } from "./runtime-config.js";

const service = new ShelfService();
await service.initialize();
const runtime = resolveServerRuntimeConfig();

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot =
  process.env.NODE_ENV === "production" ? path.resolve(here, "../../web/dist") : undefined;
const port = Number(process.env.USHELF_PORT ?? 43110);
const hostname = process.env.USHELF_HOST ?? "127.0.0.1";
const basePath = runtime.basePath;
const remoteAuth = runtime.publicUrl
  ? await createRemoteAuth({
      authDir: runtime.authDir,
      publicUrl: runtime.publicUrl,
      ...(process.env.USHELF_AUTH_SECRET ? { suppliedSecret: process.env.USHELF_AUTH_SECRET } : {}),
    })
  : undefined;

if (remoteAuth?.claimCode) {
  console.warn(`uShelf is unclaimed. One-time setup code: ${remoteAuth.claimCode}`);
}

serve(
  {
    fetch: createApp(
      service,
      webRoot,
      basePath,
      remoteAuth && runtime.publicUrl
        ? { auth: remoteAuth, publicUrl: runtime.publicUrl }
        : undefined,
    ).fetch,
    port,
    hostname,
  },
  (info) => {
    console.log(
      `uShelf is reading at ${runtime.publicUrl?.origin ?? `http://${hostname}:${info.port}`}`,
    );
  },
);
