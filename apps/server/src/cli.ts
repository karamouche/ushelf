import { ShelfService } from "@ushelf/core";
import { createRemoteAuth } from "./auth.js";
import { resolveServerRuntimeConfig } from "./runtime-config.js";

const service = new ShelfService();
await service.initialize();
const [command, argument] = process.argv.slice(2);

if (command === "rebuild-index") {
  const count = await service.rebuildIndex();
  console.log(`Rebuilt the index from ${count} Markdown item${count === 1 ? "" : "s"}.`);
} else if (command === "import") {
  if (!argument) throw new Error("Usage: pnpm import -- /absolute/path/to/item.md");
  const item = await service.importMarkdown(argument);
  console.log(`Imported ${item.title} (${item.id}).`);
} else if (command === "reset-password") {
  const runtime = resolveServerRuntimeConfig();
  if (!runtime.publicUrl) throw new Error("Password recovery is only available in remote mode");
  const remoteAuth = await createRemoteAuth({
    authDir: runtime.authDir,
    publicUrl: runtime.publicUrl,
    ...(process.env.USHELF_AUTH_SECRET ? { suppliedSecret: process.env.USHELF_AUTH_SECRET } : {}),
  });
  try {
    const reset = remoteAuth.issuePasswordReset();
    console.log(`Password-reset code: ${reset.code}`);
    console.log(`Expires at: ${reset.expiresAt}`);
  } finally {
    remoteAuth.close();
  }
} else {
  throw new Error("Unknown command. Use rebuild-index, import, or reset-password.");
}
