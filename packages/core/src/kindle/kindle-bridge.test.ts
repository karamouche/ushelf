import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../configuration/ushelf-config.js";
import { bridgeEnvironment, KindleBridgeGateway } from "./kindle-bridge.js";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

describe("Kindle bridge environment", () => {
  it("passes runtime, proxy, and TLS settings but no server secrets", () => {
    const environment = bridgeEnvironment(
      {
        PATH: "/usr/bin",
        HTTPS_PROXY: "http://proxy.internal:3128",
        SSL_CERT_FILE: "/etc/ssl/cert.pem",
        LC_ALL: "C.UTF-8",
        USHELF_API_TOKEN: "t".repeat(43),
        USHELF_APP_PASSWORD: "a strong password",
        USHELF_SECRETS_DIR: "/somewhere/else",
        AWS_SECRET_ACCESS_KEY: "unrelated secret",
      },
      "/data/secrets",
    );

    expect(environment).toEqual({
      PATH: "/usr/bin",
      HTTPS_PROXY: "http://proxy.internal:3128",
      SSL_CERT_FILE: "/etc/ssl/cert.pem",
      LC_ALL: "C.UTF-8",
      USHELF_SECRETS_DIR: "/data/secrets",
    });
  });

  it("starts the bridge without the server's API token or app password", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ushelf-kindle-bridge-"));
    roots.push(root);
    const bridge = path.join(root, "bridge.sh");
    await writeFile(
      bridge,
      `#!/bin/sh\nprintf '{"ok":true,"result":{"accountName":"%s","homeRegion":"%s","serial":"x"}}' "\${USHELF_API_TOKEN:-unset}\${USHELF_APP_PASSWORD:-unset}" "$USHELF_SECRETS_DIR"\n`,
    );
    await chmod(bridge, 0o755);
    const config = { ...resolveConfig(root), kindleBridgePath: bridge };
    const previous = {
      token: process.env.USHELF_API_TOKEN,
      password: process.env.USHELF_APP_PASSWORD,
    };
    process.env.USHELF_API_TOKEN = "t".repeat(43);
    process.env.USHELF_APP_PASSWORD = "a strong password";
    try {
      await expect(new KindleBridgeGateway(config).status()).resolves.toMatchObject({
        accountName: "unsetunset",
        homeRegion: config.secretsDir,
      });
    } finally {
      for (const [name, value] of [
        ["USHELF_API_TOKEN", previous.token],
        ["USHELF_APP_PASSWORD", previous.password],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
