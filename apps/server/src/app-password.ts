import { readFileSync } from "node:fs";
import path from "node:path";
import { resolveConfig } from "@ushelf/core";

export function resolveAppPassword(
  environmentValue = process.env.USHELF_APP_PASSWORD,
  secretsDir = resolveConfig().secretsDir,
): string | undefined {
  if (environmentValue) return environmentValue;
  let stored: string;
  try {
    stored = readFileSync(path.join(secretsDir, "app-password"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!stored) throw new Error("App password file is empty");
  return stored;
}
