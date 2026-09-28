import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { parseFrontmatter } from './frontmatter.ts';
import { defineTool } from './tools/define.ts';
import { resolveInside } from './tools/node.ts';
import type { Tool } from './types.ts';
import { expandHome, globToRegExp, truncate } from './util.ts';

/** A skill in the open Agent Skills format: a folder with SKILL.md (name + description frontmatter) and resources. */
export interface Skill { name: string; description: string; dir: string }

/** Directories scanned for skills when nothing else is configured. */
export const DEFAULT_SKILL_DIRS = ['skills', '.reinloop/skills'];

async function readSkill(dir: string): Promise<Skill> {
  const { data } = parseFrontmatter(await readFile(join(dir, 'SKILL.md'), 'utf8'));
  const name = typeof data.name === 'string' && data.name ? data.name : dir.split(sep).pop()!;
  if (typeof data.description !== 'string' || !data.description.trim()) throw new Error(`${join(dir, 'SKILL.md')}: "description" is required`);
  return { name, description: data.description.trim(), dir };
}

/** Finds skills in each directory: either the directory itself holds SKILL.md, or its subfolders do. */
export async function discoverSkills(dirs: string[], baseDir = process.cwd()): Promise<Skill[]> {
  const found = new Map<string, Skill>();
  for (const d of dirs) {
    const abs = resolve(baseDir, expandHome(d));
    if (!existsSync(abs)) continue;
    const candidates = existsSync(join(abs, 'SKILL.md'))
      ? [abs]
      : (await readdir(abs, { withFileTypes: true })).filter((e) => e.isDirectory() && existsSync(join(abs, e.name, 'SKILL.md'))).map((e) => join(abs, e.name));
    for (const dir of candidates.sort()) {
      const skill = await readSkill(dir);
      if (!found.has(skill.name)) found.set(skill.name, skill);
    }
  }
  return [...found.values()];
}

/** Selects skills by name or glob (`"*"`, `"pdf-*"`); unknown exact names are an error. */
export function selectSkills(all: Skill[], patterns: string[]): Skill[] {
  const picked = new Map<string, Skill>();
  for (const p of patterns) {
    const re = globToRegExp(p);
    const hits = all.filter((s) => re.test(s.name));
    if (!hits.length && !p.includes('*')) throw new Error(`unknown skill "${p}" (available: ${all.map((s) => s.name).join(', ') || 'none'})`);
    for (const s of hits) picked.set(s.name, s);
  }
  return [...picked.values()];
}

async function listFiles(dir: string, base = dir, out: string[] = []): Promise<string[]> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) await listFiles(full, base, out);
    else if (e.name !== 'SKILL.md') out.push(relative(base, full).split(sep).join('/'));
  }
  return out;
}

/**
 * One tool for all of an agent's skills (progressive disclosure): its description lists only names and
 * descriptions; calling it loads SKILL.md and the file list, and `file` loads a bundled resource.
 */
export function skillTool(skills: Skill[]): Tool<{ name: string; file?: string }> {
  const byName = new Map(skills.map((s) => [s.name, s]));
  const index = skills.map((s) => `- ${s.name}: ${truncate(s.description.replace(/\s+/g, ' '), 300)}`).join('\n');
  return defineTool({
    name: 'skill',
    description: `Load a skill: expert instructions and resources for a kind of task. Before a task that matches a skill, load it and follow it.\n\nAvailable skills:\n${index}`,
    risk: 'read',
    schema: {
      type: 'object',
      properties: {
        name: { enum: skills.map((s) => s.name) },
        file: { type: 'string', description: 'A resource path listed by the skill, e.g. "reference/forms.md"' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    async run({ name, file }) {
      const skill = byName.get(name)!;
      if (file) {
        const path = await resolveInside(skill.dir, file);
        if ((await stat(path)).size > 1_000_000) return { content: `${file} is larger than 1 MB`, isError: true };
        return readFile(path, 'utf8');
      }
      const { body } = parseFrontmatter(await readFile(join(skill.dir, 'SKILL.md'), 'utf8'));
      const files = await listFiles(skill.dir);
      return [
        body.trim(),
        '',
        `Skill folder: ${skill.dir}`,
        files.length ? `Resources (load with file=<path>; run scripts with the shell tool if you have it):\n${files.map((f) => `- ${f}`).join('\n')}` : 'No bundled resources.',
      ].join('\n');
    },
  });
}
