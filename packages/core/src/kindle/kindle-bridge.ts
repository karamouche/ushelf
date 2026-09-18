import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { UshelfConfig } from "../configuration/ushelf-config.js";
import { KindleError, type KindleDevice } from "../domain/kindle.js";

interface BridgeEnvelope<T> {
  ok: boolean;
  result?: T;
  error?: { code: string; message: string };
}

interface BridgeStatus {
  accountName: string;
  homeRegion: string;
  serial: string;
}

export interface KindleGateway {
  status(signal?: AbortSignal): Promise<BridgeStatus>;
  devices(signal?: AbortSignal): Promise<KindleDevice[]>;
  send(
    input: {
      bytes: Uint8Array;
      title: string;
      author?: string;
      targetSerial: string;
    },
    signal?: AbortSignal,
  ): Promise<string>;
}

export class KindleBridgeGateway implements KindleGateway {
  constructor(private readonly config: UshelfConfig) {}

  status(signal?: AbortSignal): Promise<BridgeStatus> {
    return this.call<BridgeStatus>("status", undefined, signal);
  }

  async devices(signal?: AbortSignal): Promise<KindleDevice[]> {
    return (await this.call<{ devices: KindleDevice[] }>("devices", undefined, signal)).devices;
  }

  async send(
    input: { bytes: Uint8Array; title: string; author?: string; targetSerial: string },
    signal?: AbortSignal,
  ): Promise<string> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ushelf-kindle-"));
    const documentPath = path.join(directory, "document.epub");
    try {
      await writeFile(documentPath, input.bytes, { mode: 0o600 });
      const result = await this.call<{ sku: string }>(
        "send",
        {
          path: documentPath,
          size: input.bytes.byteLength,
          title: input.title,
          author: input.author ?? "",
          targetSerial: input.targetSerial,
        },
        signal,
      );
      return result.sku;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private call<T>(command: string, input?: unknown, signal?: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        this.config.kindleBridgePath,
        [command],
        {
          env: {
            ...process.env,
            USHELF_SECRETS_DIR: this.config.secretsDir,
          },
          encoding: "utf8",
          maxBuffer: 128 * 1024,
          timeout: 120_000,
          ...(signal ? { signal } : {}),
        },
        (error, stdout) => {
          if (error) {
            if (
              error.killed ||
              error.code === "ABORT_ERR" ||
              error.code === "ETIMEDOUT" ||
              error.signal === "SIGTERM"
            ) {
              reject(
                new KindleError(
                  "timeout",
                  "Amazon did not respond in time. The delivery result is unknown; do not retry automatically.",
                ),
              );
              return;
            }
            reject(new KindleError("bridge_unavailable", "The Kindle integration is unavailable."));
            return;
          }
          let envelope: BridgeEnvelope<T>;
          try {
            envelope = JSON.parse(stdout) as BridgeEnvelope<T>;
          } catch {
            reject(
              new KindleError(
                "bridge_unavailable",
                "The Kindle integration returned an invalid response.",
              ),
            );
            return;
          }
          if (!envelope.ok || !envelope.result) {
            reject(
              new KindleError(
                envelope.error?.code ?? "bridge_unavailable",
                envelope.error?.message ?? "The Kindle integration failed.",
              ),
            );
            return;
          }
          resolve(envelope.result);
        },
      );
      if (input !== undefined) child.stdin?.end(JSON.stringify(input));
      else child.stdin?.end();
    });
  }
}
