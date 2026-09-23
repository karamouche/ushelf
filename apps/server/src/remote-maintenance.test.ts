import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createGzip } from "node:zlib";
import { describe, expect, it } from "vitest";
import { pack } from "tar-stream";
import type { ShelfService } from "@ushelf/core";
import { createRemoteMaintenanceHandlers } from "./remote-maintenance.js";

async function archive(entries: Array<{ name: string; contents: string }>): Promise<Buffer> {
  const output = pack();
  const gzip = createGzip();
  output.pipe(gzip);
  const chunks: Buffer[] = [];
  const done = (async () => {
    for await (const chunk of gzip) chunks.push(Buffer.from(chunk as Uint8Array));
  })();
  for (const entry of entries) {
    await new Promise<void>((resolve, reject) => {
      output.entry({ name: entry.name }, entry.contents, (error) =>
        error ? reject(error) : resolve(),
      );
    });
  }
  output.finalize();
  await done;
  return Buffer.concat(chunks);
}

describe("remote migration safety", () => {
  it("rejects traversal and preserves the target library", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ushelf-migration-test-"));
    const marker = path.join(root, "library", ".gitkeep");
    await fs.mkdir(path.dirname(marker), { recursive: true });
    await fs.writeFile(marker, "keep");
    try {
      const handlers = createRemoteMaintenanceHandlers({
        root,
        service: { listItems: () => [], rebuildIndex: async () => 0 } as unknown as ShelfService,
        protect: (_scopes, handler) => handler,
      });
      const body = await archive([{ name: "library/../../escape", contents: "bad" }]);
      await expect(
        handlers.migrate(
          new Request("https://shelf.example/api/remote/migration", {
            method: "PUT",
            body: new Uint8Array(body),
          }),
        ),
      ).rejects.toThrow("Unsafe archive path");
      expect(await fs.readFile(marker, "utf8")).toBe("keep");
      expect(await fs.readdir(root)).not.toContain("escape");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects manifest digest mismatches before installing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ushelf-migration-test-"));
    try {
      const handlers = createRemoteMaintenanceHandlers({
        root,
        service: { listItems: () => [], rebuildIndex: async () => 0 } as unknown as ShelfService,
        protect: (_scopes, handler) => handler,
      });
      const body = await archive([
        {
          name: "manifest.json",
          contents: JSON.stringify({
            format: 1,
            version: "dev",
            entries: [{ path: "recipes/default.md", size: 3, sha256: "0".repeat(64) }],
          }),
        },
        { name: "recipes/default.md", contents: "abc" },
      ]);
      await expect(
        handlers.migrate(
          new Request("https://shelf.example/api/remote/migration", {
            method: "PUT",
            body: new Uint8Array(body),
          }),
        ),
      ).rejects.toThrow("digest mismatch");
      expect(await fs.readdir(root)).not.toContain("recipes");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("installs a verified archive and rebuilds the index", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ushelf-migration-test-"));
    let rebuilds = 0;
    try {
      const handlers = createRemoteMaintenanceHandlers({
        root,
        service: {
          listItems: () => [],
          rebuildIndex: async () => ++rebuilds,
        } as unknown as ShelfService,
        protect: (_scopes, handler) => handler,
      });
      const recipe = "# Imported recipe\n";
      const body = await archive([
        {
          name: "manifest.json",
          contents: JSON.stringify({
            format: 1,
            version: "dev",
            createdAt: new Date().toISOString(),
            entries: [
              {
                path: "recipes/default.md",
                size: Buffer.byteLength(recipe),
                sha256: createHash("sha256").update(recipe).digest("hex"),
              },
            ],
          }),
        },
        { name: "recipes/default.md", contents: recipe },
      ]);
      const response = await handlers.migrate(
        new Request("https://shelf.example/api/remote/migration", {
          method: "PUT",
          body: new Uint8Array(body),
        }),
      );
      expect(response.status).toBe(200);
      expect(await fs.readFile(path.join(root, "recipes", "default.md"), "utf8")).toBe(recipe);
      expect(rebuilds).toBe(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
