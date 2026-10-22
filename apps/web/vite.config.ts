import { defineConfig, loadEnv } from "vite";
import legacy from "@vitejs/plugin-legacy";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { resolveWebBasePath } from "./base-path.js";

const webRoot = fileURLToPath(new URL(".", import.meta.url));
const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, workspaceRoot, "");
  const base = resolveWebBasePath(process.env.USHELF_WEB_BASE_PATH ?? env.USHELF_WEB_BASE_PATH);
  const apiPrefix = `${base.slice(0, -1)}/api`;
  const authPrefix = `${base.slice(0, -1)}/auth`;

  return {
    root: webRoot,
    base: command === "build" ? "./" : base,
    plugins: [
      react(),
      // E-reader browsers such as the Kindle's run old engines that cannot parse the default
      // modern syntax, which leaves a blank page. Modern chunks are lowered to the plugin's
      // Chrome 64 / Safari 12 targets with usage-based polyfills, and engines without ES modules
      // get a SystemJS build transpiled down to ES5.
      legacy({ targets: ["defaults", "chrome >= 40", "safari >= 8"], modernPolyfills: true }),
    ],
    server: {
      proxy: {
        [apiPrefix]: {
          target: "http://127.0.0.1:43110",
        },
        [authPrefix]: {
          target: "http://127.0.0.1:43110",
        },
      },
    },
    build: { outDir: "dist", emptyOutDir: true },
  };
});
