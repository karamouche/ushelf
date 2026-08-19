import { ShelfService } from "@ushelf/core";

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
} else {
  throw new Error("Unknown command. Use rebuild-index or import.");
}
