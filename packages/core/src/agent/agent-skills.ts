import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface AgentSkillFile {
  path: string;
  content: string;
}

export interface AgentSkill {
  name: string;
  files: AgentSkillFile[];
}

const MAX_SKILL_FILE_BYTES = 256 * 1024;
const SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** Read the bundled agent skills so clients install the workflows matching this server. */
export async function readAgentSkills(root: string): Promise<AgentSkill[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const skills: AgentSkill[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || !SKILL_NAME.test(entry.name)) continue;
    const directory = path.join(root, entry.name);
    const files = await readSkillFiles(directory, "");
    if (files.some((file) => file.path === "SKILL.md")) skills.push({ name: entry.name, files });
  }
  return skills;
}

async function readSkillFiles(root: string, relative: string): Promise<AgentSkillFile[]> {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const files: AgentSkillFile[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith(".")) continue;
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await readSkillFiles(root, child)));
      continue;
    }
    const absolute = path.join(root, child);
    const info = await lstat(absolute);
    if (!info.isFile()) throw new Error(`Skill entry ${child} must be a regular file`);
    if (info.size > MAX_SKILL_FILE_BYTES) throw new Error(`Skill file ${child} is too large`);
    files.push({ path: child, content: await readFile(absolute, "utf8") });
  }
  return files;
}
