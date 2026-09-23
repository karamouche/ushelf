import path from "node:path";
import { resolveConfig } from "@ushelf/core";

export type UshelfMode = "local" | "remote";

export interface ServerRuntimeConfig {
  mode: UshelfMode;
  publicUrl?: URL;
  basePath: string;
  authDir: string;
}

export function resolveServerRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): ServerRuntimeConfig {
  const modeValue = env.USHELF_MODE?.trim() || "local";
  if (modeValue !== "local" && modeValue !== "remote") {
    throw new Error("USHELF_MODE must be either local or remote");
  }
  const mode: UshelfMode = modeValue;
  const root = resolveConfig(env.USHELF_ROOT).root;
  const basePath = normalizeBasePath(env.USHELF_WEB_BASE_PATH?.trim() || "/");

  if (mode === "local") return { mode, basePath, authDir: path.join(root, "auth") };
  if (basePath !== "/") throw new Error("Remote mode must be served at the origin root");
  const publicUrl = parsePublicUrl(env.USHELF_PUBLIC_URL);
  return { mode, publicUrl, basePath, authDir: path.join(root, "auth") };
}

function parsePublicUrl(value: string | undefined): URL {
  if (!value) throw new Error("USHELF_PUBLIC_URL is required in remote mode");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("USHELF_PUBLIC_URL must be a credential-free HTTPS origin");
  }
  if (url.pathname !== "/") throw new Error("USHELF_PUBLIC_URL must not contain a path");
  return new URL(url.origin);
}

function normalizeBasePath(value: string): string {
  const normalized = value.trim() || "/";
  if (
    !normalized.startsWith("/") ||
    normalized.startsWith("//") ||
    !/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(normalized)
  ) {
    throw new Error("USHELF_WEB_BASE_PATH must be a safe absolute URL path");
  }
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}
