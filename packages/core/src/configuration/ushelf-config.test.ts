import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { resolveConfig } from "./ushelf-config.js";

describe("resolveConfig", () => {
  const previousStateDir = process.env.USHELF_STATE_DIR;
  const previousSecretsDir = process.env.USHELF_SECRETS_DIR;

  afterEach(() => {
    if (previousStateDir === undefined) delete process.env.USHELF_STATE_DIR;
    else process.env.USHELF_STATE_DIR = previousStateDir;
    if (previousSecretsDir === undefined) delete process.env.USHELF_SECRETS_DIR;
    else process.env.USHELF_SECRETS_DIR = previousSecretsDir;
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
});
