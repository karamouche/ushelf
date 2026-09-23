import { createHash, randomUUID } from "node:crypto";
import { createGunzip, createGzip } from "node:zlib";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { extract, pack, type Header } from "tar-stream";
import { resolveConfig, ShelfService } from "@ushelf/core";

const archiveFormat = 1;
const maxArchiveBytes = 2 * 1024 * 1024 * 1024;

interface Manifest {
  format: number;
  version: string;
  createdAt: string;
  entries: Array<{ path: string; size: number; sha256: string }>;
}

export function createRemoteMaintenanceHandlers(options: {
  root: string;
  service: ShelfService;
  protect: (
    scopes: string[],
    handler: (request: Request) => Promise<Response>,
  ) => (request: Request) => Promise<Response>;
}) {
  const config = resolveConfig(options.root);
  return {
    rebuild: options.protect(["ushelf:write"], async () =>
      Response.json({ rebuilt: await options.service.rebuildIndex() }),
    ),
    importMarkdown: options.protect(["ushelf:write"], async (request) => {
      const body = (await request.json()) as { filename?: string; markdown?: string };
      if (!body.markdown || Buffer.byteLength(body.markdown) > 10 * 1024 * 1024) {
        return Response.json({ error: "Markdown import is empty or too large" }, { status: 400 });
      }
      const temporaryDir = await fs.mkdtemp(path.join(config.root, ".import-"));
      try {
        const source = path.join(temporaryDir, safeFilename(body.filename ?? "item.md"));
        await fs.writeFile(source, body.markdown, { mode: 0o600 });
        return Response.json({ item: await options.service.importMarkdown(source) });
      } finally {
        await fs.rm(temporaryDir, { recursive: true, force: true });
      }
    }),
    kindleUpload: options.protect(["ushelf:kindle"], async (request) => {
      const raw = Buffer.from(await request.arrayBuffer());
      if (raw.length === 0 || raw.length > 1024 * 1024) {
        return Response.json({ error: "Invalid Kindle credential" }, { status: 400 });
      }
      JSON.parse(raw.toString("utf8"));
      await fs.mkdir(config.secretsDir, { recursive: true, mode: 0o700 });
      const temporary = `${config.kindleCredentialPath}.tmp`;
      await fs.writeFile(temporary, raw, { mode: 0o600 });
      await fs.rename(temporary, config.kindleCredentialPath);
      return Response.json({ configured: true });
    }),
    kindleStatus: options.protect(["ushelf:kindle"], async (request) =>
      Response.json(await options.service.kindleStatus(request.signal)),
    ),
    kindleDelete: options.protect(["ushelf:kindle"], async () => {
      await fs.rm(config.kindleCredentialPath, { force: true });
      return Response.json({ configured: false });
    }),
    exportArchive: options.protect(["ushelf:read"], async () => {
      const stream = await archiveStream(config.root, process.env.USHELF_VERSION ?? "dev");
      return new Response(stream, {
        headers: {
          "content-type": "application/gzip",
          "content-disposition": 'attachment; filename="ushelf-export.tar.gz"',
        },
      });
    }),
    skillsArchive: options.protect(["ushelf:read"], async () => {
      const skillsRoot = path.resolve(
        process.env.USHELF_SKILLS_DIR ?? fileURLToPath(new URL("../../../skills", import.meta.url)),
      );
      const files = await collectFiles(skillsRoot, ["ushelf-ingest", "ushelf-library"]);
      const output = pack();
      queueMicrotask(() => {
        for (const file of files) output.entry({ name: file.name, mode: 0o600 }, file.bytes);
        output.finalize();
      });
      return new Response(Readable.toWeb(output as unknown as Readable) as ReadableStream, {
        headers: { "content-type": "application/x-tar" },
      });
    }),
    migrate: options.protect(["ushelf:write"], async (request) => {
      if (
        options.service.listItems({ limit: 1, offset: 0 }).length !== 0 ||
        (await hasLibraryFiles(config.libraryDir))
      ) {
        return Response.json({ error: "Remote library must be empty" }, { status: 409 });
      }
      await installMigration(request, config.root, options.service);
      return Response.json({
        migrated: true,
        rebuilt: options.service.listItems({ limit: 1, offset: 0 }).length,
      });
    }),
  };
}

async function archiveStream(root: string, version: string): Promise<ReadableStream> {
  const files = await collectFiles(root, ["library", "recipes"]);
  const manifest: Manifest = {
    format: archiveFormat,
    version,
    createdAt: new Date().toISOString(),
    entries: files.map(({ name, bytes }) => ({
      path: name,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    })),
  };
  const output = pack();
  const gzip = createGzip({ level: 6 });
  output.pipe(gzip);
  queueMicrotask(() => {
    output.entry({ name: "manifest.json", mode: 0o600 }, JSON.stringify(manifest, null, 2));
    for (const file of files) output.entry({ name: file.name, mode: 0o600 }, file.bytes);
    output.finalize();
  });
  return Readable.toWeb(gzip) as ReadableStream;
}

async function collectFiles(root: string, names: string[]) {
  const result: Array<{ name: string; bytes: Buffer }> = [];
  const visit = async (relative: string) => {
    const absolute = path.join(root, relative);
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(absolute, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path.posix.join(relative.replaceAll(path.sep, "/"), entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Export refuses symbolic link ${child}`);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile())
        result.push({ name: child, bytes: await fs.readFile(path.join(root, child)) });
    }
  };
  for (const name of names) await visit(name);
  return result;
}

async function installMigration(
  request: Request,
  root: string,
  service: ShelfService,
): Promise<void> {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > maxArchiveBytes) throw new Error("Migration archive exceeds 2 GiB");
  if (!request.body) throw new Error("Migration archive is empty");
  const staging = path.join(root, `.migration-${randomUUID()}`);
  await fs.mkdir(staging, { recursive: true, mode: 0o700 });
  try {
    const entries = new Map<string, { size: number; sha256: string }>();
    let manifest: Manifest | undefined;
    let total = 0;
    let extractionError: Error | undefined;
    const untar = extract();
    untar.on("entry", (header: Header, stream, next) => {
      void (async () => {
        try {
          if (extractionError) {
            stream.resume();
            next();
            return;
          }
          const name = validateArchivePath(header);
          if (name === "manifest.json") {
            if (header.size > 1024 * 1024) throw new Error("Migration manifest is too large");
            const chunks: Buffer[] = [];
            for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
            manifest = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Manifest;
          } else {
            if (entries.has(name)) throw new Error(`Duplicate archive entry ${name}`);
            const destination = path.join(staging, name);
            await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
            const handle = await fs.open(destination, "wx", 0o600);
            const digest = createHash("sha256");
            let size = 0;
            try {
              for await (const chunk of stream) {
                const bytes = Buffer.from(chunk as Uint8Array);
                total += bytes.length;
                size += bytes.length;
                if (total > maxArchiveBytes) throw new Error("Migration archive exceeds 2 GiB");
                digest.update(bytes);
                let offset = 0;
                while (offset < bytes.length) {
                  const result = await handle.write(bytes, offset, bytes.length - offset);
                  offset += result.bytesWritten;
                }
              }
            } finally {
              await handle.close();
            }
            entries.set(name, {
              size,
              sha256: digest.digest("hex"),
            });
          }
          next();
        } catch (error) {
          extractionError = error as Error;
          stream.resume();
          next();
        }
      })();
    });
    await pipeline(Readable.fromWeb(request.body as never), createGunzip(), untar);
    if (extractionError) throw extractionError;
    verifyManifest(manifest, entries);
    const stagedConfig = resolveConfig(staging);
    stagedConfig.stateDir = path.join(staging, "state");
    stagedConfig.databasePath = path.join(stagedConfig.stateDir, "ushelf.db");
    stagedConfig.secretsDir = path.join(staging, "secrets");
    stagedConfig.kindleCredentialPath = path.join(stagedConfig.secretsDir, "kindle.json");
    const stagedService = new ShelfService(stagedConfig);
    await stagedService.initialize();
    await atomicInstall(staging, root, service);
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

function validateArchivePath(header: Header): string {
  if (header.type !== "file") throw new Error(`Archive entry ${header.name} is not a regular file`);
  const name = path.posix.normalize(header.name.replace(/^\.\//, ""));
  if (
    name === "." ||
    name.startsWith("../") ||
    name.startsWith("/") ||
    name.includes("\\") ||
    header.name.split("/").includes("..")
  ) {
    throw new Error(`Unsafe archive path ${header.name}`);
  }
  if (
    name !== "manifest.json" &&
    !name.startsWith("library/") &&
    !name.startsWith("recipes/") &&
    name !== "secrets/kindle.json"
  )
    throw new Error(`Unexpected archive entry ${name}`);
  return name;
}

function verifyManifest(
  manifest: Manifest | undefined,
  actual: Map<string, { size: number; sha256: string }>,
) {
  if (!manifest || manifest.format !== archiveFormat)
    throw new Error("Unsupported or missing migration manifest");
  const serverVersion = process.env.USHELF_VERSION ?? "dev";
  if (manifest.version !== serverVersion)
    throw new Error(`Migration version ${manifest.version} does not match server ${serverVersion}`);
  if (manifest.entries.length !== actual.size)
    throw new Error("Migration manifest entry count does not match archive");
  for (const expected of manifest.entries) {
    if (typeof expected.path !== "string" || !/^[a-f0-9]{64}$/.test(expected.sha256))
      throw new Error("Invalid migration manifest entry");
    const found = actual.get(expected.path);
    if (!found || found.size !== expected.size || found.sha256 !== expected.sha256)
      throw new Error(`Migration digest mismatch for ${expected.path}`);
  }
}

async function atomicInstall(staging: string, root: string, service: ShelfService) {
  const backup = path.join(root, `.migration-backup-${randomUUID()}`);
  await fs.mkdir(backup, { mode: 0o700 });
  const installed: string[] = [];
  const backedUp: string[] = [];
  try {
    for (const name of ["library", "recipes", "secrets"] as const) {
      const source = path.join(staging, name);
      try {
        await fs.access(source);
      } catch {
        continue;
      }
      const destination = path.join(root, name);
      try {
        await fs.rename(destination, path.join(backup, name));
        backedUp.push(name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await fs.rename(source, destination);
      installed.push(name);
    }
    await service.rebuildIndex();
    await fs.rm(backup, { recursive: true, force: true });
  } catch (error) {
    for (const name of installed.reverse()) {
      await fs.rm(path.join(root, name), { recursive: true, force: true });
    }
    for (const name of backedUp.reverse()) {
      await fs.rename(path.join(backup, name), path.join(root, name));
    }
    await service.rebuildIndex().catch(() => undefined);
    throw error;
  }
}

function safeFilename(value: string): string {
  const filename = path.basename(value);
  return filename.endsWith(".md") ? filename : `${filename}.md`;
}

async function hasLibraryFiles(libraryDir: string): Promise<boolean> {
  try {
    for (const entry of await fs.readdir(libraryDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name !== ".gitkeep") return true;
      if (entry.isDirectory() && (await hasLibraryFiles(path.join(libraryDir, entry.name))))
        return true;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return false;
}
