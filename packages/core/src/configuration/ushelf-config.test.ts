import { afterEach, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "./ushelf-config.js";

describe("resolveConfig", () => {
  const previousRoot = process.env.USHELF_ROOT;
  const previousStateDir = process.env.USHELF_STATE_DIR;
  const previousSecretsDir = process.env.USHELF_SECRETS_DIR;
  const previousKindleBridge = process.env.USHELF_KINDLE_BRIDGE;
  const previousNodeEnv = process.env.NODE_ENV;
  const previousCwd = process.cwd();

  beforeEach(() => {
    delete process.env.USHELF_ROOT;
    delete process.env.USHELF_STATE_DIR;
    delete process.env.USHELF_SECRETS_DIR;
  });

  afterEach(() => {
    if (previousRoot === undefined) delete process.env.USHELF_ROOT;
    else process.env.USHELF_ROOT = previousRoot;
    if (previousStateDir === undefined) delete process.env.USHELF_STATE_DIR;
    else process.env.USHELF_STATE_DIR = previousStateDir;
    if (previousSecretsDir === undefined) delete process.env.USHELF_SECRETS_DIR;
    else process.env.USHELF_SECRETS_DIR = previousSecretsDir;
    if (previousKindleBridge === undefined) delete process.env.USHELF_KINDLE_BRIDGE;
    else process.env.USHELF_KINDLE_BRIDGE = previousKindleBridge;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    process.chdir(previousCwd);
  });

  it("derives state and secrets directories directly from the root by default", () => {
    const config = resolveConfig("/tmp/ushelf-root");
    expect(config.stateDir).toBe(path.resolve("/tmp/ushelf-root/state"));
    expect(config.databasePath).toBe(path.resolve("/tmp/ushelf-root/state/ushelf.db"));
    expect(config.secretsDir).toBe(path.resolve("/tmp/ushelf-root/secrets"));
    expect(config.kindleCredentialPath).toBe(path.resolve("/tmp/ushelf-root/secrets/kindle.json"));
  });

  it("uses the current working directory as the complete root when no variables are set", () => {
    process.chdir("/tmp");

    const config = resolveConfig();

    expect(config.root).toBe(path.resolve("/tmp"));
    expect(config.libraryDir).toBe(path.resolve("/tmp/library"));
    expect(config.recipesDir).toBe(path.resolve("/tmp/recipes"));
    expect(config.stateDir).toBe(path.resolve("/tmp/state"));
    expect(config.secretsDir).toBe(path.resolve("/tmp/secrets"));
  });

  it("moves the complete default layout when USHELF_ROOT is set", () => {
    process.env.USHELF_ROOT = "/tmp/ushelf-home";

    const config = resolveConfig();

    expect(config.libraryDir).toBe(path.resolve("/tmp/ushelf-home/library"));
    expect(config.recipesDir).toBe(path.resolve("/tmp/ushelf-home/recipes"));
    expect(config.stateDir).toBe(path.resolve("/tmp/ushelf-home/state"));
    expect(config.secretsDir).toBe(path.resolve("/tmp/ushelf-home/secrets"));
  });

  it("allows installed runtimes to use a separate state mount", () => {
    process.env.USHELF_STATE_DIR = "/tmp/ushelf-state";
    const config = resolveConfig("/tmp/ushelf-root");
    expect(config.stateDir).toBe(path.resolve("/tmp/ushelf-state"));
    expect(config.databasePath).toBe(path.resolve("/tmp/ushelf-state/ushelf.db"));
  });

  it("allows the runtime to use a read-only secrets mount", () => {
    process.env.USHELF_SECRETS_DIR = "/tmp/ushelf-secrets";
    const config = resolveConfig("/tmp/ushelf-root");
    expect(config.secretsDir).toBe(path.resolve("/tmp/ushelf-secrets"));
    expect(config.kindleCredentialPath).toBe(path.resolve("/tmp/ushelf-secrets/kindle.json"));
  });

  it("resolves the development Kindle bridge independently of the process directory", () => {
    delete process.env.USHELF_KINDLE_BRIDGE;
    process.env.NODE_ENV = "development";
    process.chdir(fileURLToPath(new URL("../../../../apps/server", import.meta.url)));

    const config = resolveConfig("/tmp/ushelf-root");

    expect(config.kindleBridgePath).toBe(
      fileURLToPath(new URL("../../../../apps/cli/dist/ushelf-kindle-bridge", import.meta.url)),
    );
  });
});
