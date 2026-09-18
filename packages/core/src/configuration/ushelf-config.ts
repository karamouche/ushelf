import path from "node:path";
import { fileURLToPath } from "node:url";

const developmentKindleBridgePath = fileURLToPath(
  new URL("../../../../apps/cli/dist/ushelf-kindle-bridge", import.meta.url),
);

export interface UshelfConfig {
  root: string;
  libraryDir: string;
  itemsDir: string;
  historyDir: string;
  filesDir: string;
  recipesDir: string;
  stateDir: string;
  databasePath: string;
  secretsDir: string;
  kindleCredentialPath: string;
  kindleBridgePath: string;
}

export function resolveConfig(root = process.env.USHELF_ROOT ?? process.cwd()): UshelfConfig {
  const resolvedRoot = path.resolve(root);
  const libraryDir = path.join(resolvedRoot, "library");
  const stateDir = path.resolve(process.env.USHELF_STATE_DIR ?? path.join(resolvedRoot, ".ushelf"));
  const secretsDir = path.resolve(
    process.env.USHELF_SECRETS_DIR ?? path.join(resolvedRoot, ".ushelf", "secrets"),
  );
  return {
    root: resolvedRoot,
    libraryDir,
    itemsDir: path.join(libraryDir, "items"),
    historyDir: path.join(libraryDir, "history"),
    filesDir: path.join(libraryDir, "files"),
    recipesDir: path.join(resolvedRoot, "recipes"),
    stateDir,
    databasePath: path.join(stateDir, "ushelf.db"),
    secretsDir,
    kindleCredentialPath: path.join(secretsDir, "kindle.json"),
    kindleBridgePath:
      process.env.USHELF_KINDLE_BRIDGE ??
      (process.env.NODE_ENV === "production"
        ? "/app/bin/ushelf-kindle-bridge"
        : developmentKindleBridgePath),
  };
}
