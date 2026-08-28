import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const root = path.resolve("skills");
const entries = await readdir(root, { withFileTypes: true });
let count = 0;

for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  const skillFile = path.join(root, entry.name, "SKILL.md");
  if (!(await stat(skillFile).catch(() => undefined))?.isFile()) {
    throw new Error(`${entry.name}: missing SKILL.md`);
  }
  const source = await readFile(skillFile, "utf8");
  const match = source.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) throw new Error(`${entry.name}: missing YAML frontmatter`);
  const name = match[1]?.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = match[1]?.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  if (name !== entry.name) throw new Error(`${entry.name}: frontmatter name must match directory`);
  if (!description) throw new Error(`${entry.name}: description is required`);
  if (description.length > 1024)
    throw new Error(`${entry.name}: description exceeds 1024 characters`);
  if (!/^[a-z0-9-]+$/.test(name))
    throw new Error(`${entry.name}: name must use lowercase letters, digits, and hyphens`);
  count++;
}

if (count === 0) throw new Error("No skills found");
console.log(`Validated ${count} uShelf skills.`);
