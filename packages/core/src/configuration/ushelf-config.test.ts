import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "./ushelf-config.js";

describe("resolveConfig", () => {
  const previousStateDir = process.env.USHELF_STATE_DIR;
  const previousSecretsDir = process.env.USHELF_SECRETS_DIR;
  const previousKindleBridge = process.env.USHELF_KINDLE_BRIDGE;
  const previousNodeEnv = process.env.NODE_ENV;
  const previousCwd = process.cwd();

  afterEach(() => {
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

  it("keeps state beneath the root by default", () => {
    const config = resolveConfig("/tmp/ushelf-root");
    expect(config.stateDir).toBe(path.resolve("/tmp/ushelf-root/.ushelf"));
    expect(config.secretsDir).toBe(path.resolve("/tmp/ushelf-root/.ushelf/secrets"));
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
