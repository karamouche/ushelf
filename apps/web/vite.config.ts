import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { resolveWebBasePath } from "./base-path.js";

const webRoot = fileURLToPath(new URL(".", import.meta.url));
const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, workspaceRoot, "");
  const base = resolveWebBasePath(process.env.USHELF_WEB_BASE_PATH ?? env.USHELF_WEB_BASE_PATH);
  const apiPrefix = `${base.slice(0, -1)}/api`;

  return {
    root: webRoot,
    base: command === "build" ? "./" : base,
    plugins: [react()],
    server: {
      proxy: {
        [apiPrefix]: {
          target: "http://127.0.0.1:43110",
          rewrite: (requestPath) => requestPath.slice(base.length - 1),
        },
      },
    },
    build: { outDir: "dist", emptyOutDir: true },
  };
});
