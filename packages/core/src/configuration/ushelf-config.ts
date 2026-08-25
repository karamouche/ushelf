import path from "node:path";

export interface UshelfConfig {
  root: string;
  libraryDir: string;
  itemsDir: string;
  historyDir: string;
  recipesDir: string;
  stateDir: string;
  databasePath: string;
}

export function resolveConfig(root = process.env.USHELF_ROOT ?? process.cwd()): UshelfConfig {
  const resolvedRoot = path.resolve(root);
  const libraryDir = path.join(resolvedRoot, "library");
  const stateDir = path.join(resolvedRoot, ".ushelf");
  return {
    root: resolvedRoot,
    libraryDir,
    itemsDir: path.join(libraryDir, "items"),
    historyDir: path.join(libraryDir, "history"),
    recipesDir: path.join(resolvedRoot, "recipes"),
    stateDir,
    databasePath: path.join(stateDir, "ushelf.db"),
  };
}
