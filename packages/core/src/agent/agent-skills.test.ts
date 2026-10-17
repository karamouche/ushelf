import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readAgentSkills } from "./agent-skills.js";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

async function root() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ushelf-skills-test-"));
  roots.push(directory);
  return directory;
}

describe("readAgentSkills", () => {
  it("returns skill directories with nested files and skips hidden entries", async () => {
    const directory = await root();
    await mkdir(path.join(directory, "ushelf-ingest", "agents"), { recursive: true });
    await writeFile(path.join(directory, "ushelf-ingest", "SKILL.md"), "# Ingest");
    await writeFile(path.join(directory, "ushelf-ingest", "agents", "openai.yaml"), "name: x");
    await writeFile(path.join(directory, "ushelf-ingest", ".DS_Store"), "junk");
    await writeFile(path.join(directory, ".DS_Store"), "junk");
    await mkdir(path.join(directory, "not-a-skill"));
    await writeFile(path.join(directory, "not-a-skill", "README.md"), "no skill file");

    expect(await readAgentSkills(directory)).toEqual([
      {
        name: "ushelf-ingest",
        files: [
          { path: "agents/openai.yaml", content: "name: x" },
          { path: "SKILL.md", content: "# Ingest" },
        ],
      },
    ]);
  });

  it("refuses symbolic links so only bundled files are served", async () => {
    const directory = await root();
    await mkdir(path.join(directory, "ushelf-library"));
    await writeFile(path.join(directory, "ushelf-library", "SKILL.md"), "# Library");
    await symlink("/etc/hosts", path.join(directory, "ushelf-library", "hosts"));
    await expect(readAgentSkills(directory)).rejects.toThrow(/regular file/);
  });
});
