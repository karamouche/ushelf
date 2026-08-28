import { readFile, writeFile } from "node:fs/promises";

const tag = process.argv[2];
if (!tag || !/^v?\d+\.\d+\.\d+$/.test(tag)) {
  throw new Error("Usage: node scripts/set-version.mjs vMAJOR.MINOR.PATCH");
}

const version = tag.replace(/^v/, "");
const manifests = [
  "package.json",
  "packages/core/package.json",
  "apps/mcp/package.json",
  "apps/server/package.json",
  "apps/web/package.json",
];

for (const manifest of manifests) {
  const contents = JSON.parse(await readFile(manifest, "utf8"));
  contents.version = version;
  await writeFile(manifest, `${JSON.stringify(contents, null, 2)}\n`);
}

console.log(`Applied uShelf version ${version} to ${manifests.length} manifests.`);
