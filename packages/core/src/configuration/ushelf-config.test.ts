import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { resolveConfig } from "./ushelf-config.js";

describe("resolveConfig", () => {
  const previousStateDir = process.env.USHELF_STATE_DIR;

  afterEach(() => {
    if (previousStateDir === undefined) delete process.env.USHELF_STATE_DIR;
    else process.env.USHELF_STATE_DIR = previousStateDir;
  });

  it("keeps state beneath the root by default", () => {
    const config = resolveConfig("/tmp/ushelf-root");
    expect(config.stateDir).toBe(path.resolve("/tmp/ushelf-root/.ushelf"));
  });

  it("allows installed runtimes to use a separate state mount", () => {
    process.env.USHELF_STATE_DIR = "/tmp/ushelf-state";
    const config = resolveConfig("/tmp/ushelf-root");
    expect(config.stateDir).toBe(path.resolve("/tmp/ushelf-state"));
    expect(config.databasePath).toBe(path.resolve("/tmp/ushelf-state/ushelf.db"));
  });
});
