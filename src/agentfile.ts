import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { AgentConfig, HarnessConfig, TeamConfig } from './config/load.ts';
import { parseFrontmatter } from './frontmatter.ts';
import { expandHome } from './util.ts';

/** Tool names used by other agent-file ecosystems, mapped to built-in tools. */
export const TOOL_ALIASES: Record<string, string> = {
  Read: 'read_file',
  Write: 'write_file',
  Edit: 'edit_file',
  MultiEdit: 'edit_file',
  Bash: 'shell',
  LS: 'list_dir',
  Glob: 'find_files',
  Grep: 'search_files',
};

/** Directories scanned for `*.md` agents when nothing else is configured. */
export const DEFAULT_AGENT_DIRS = ['agents', '.reinloop/agents'];

const FIELDS = new Set(['name', 'description', 'model', 'tools', 'params', 'policy', 'budget', 'compaction', 'output', 'middleware', 'asTool', 'responseCache', 'skills']);
const TEAM_FIELDS = new Set(['name', 'description', 'pattern', 'roles', 'options']);

/** Keys from other agent-file formats that have no meaning here and are skipped. */
const IGNORED = new Set(['color']);

export type ParsedFile = { kind: 'agent'; name: string; config: AgentConfig } | { kind: 'team'; name: string; config: TeamConfig };

/**
 * An agent file is Markdown: optional frontmatter for settings, body for instructions.
 * A file with a `pattern` field defines a team instead; its body becomes the description.
 * The name comes from frontmatter `name`, else the file name.
 */
export function parseAgentFile(text: string, fallbackName: string): ParsedFile {
  const { data, body } = parseFrontmatter(text);
  const fileName = typeof data.name === 'string' && data.name ? data.name : fallbackName;
  if ('pattern' in data) {
    const unknownTeam = Object.keys(data).filter((k) => !TEAM_FIELDS.has(k));
    if (unknownTeam.length) throw new Error(`unknown team field(s) ${unknownTeam.join(', ')} (allowed: ${[...TEAM_FIELDS].join(', ')})`);
    const { name: _, ...team } = data;
    const description = (team.description as string | undefined) ?? (body.trim() || undefined);
    return { kind: 'team', name: fileName, config: { ...(team as unknown as TeamConfig), ...(description && { description }) } };
  }
  const unknown = Object.keys(data).filter((k) => !FIELDS.has(k) && !IGNORED.has(k));
  if (unknown.length) throw new Error(`unknown field(s) ${unknown.join(', ')} (allowed: ${[...FIELDS].join(', ')})`);
  const { name: _name, tools, color: _color, ...rest } = data as Record<string, unknown>;
  const list = typeof tools === 'string' ? tools.split(/[\s,]+/).filter(Boolean) : (tools as string[] | undefined);
  const instructions = body.trim();
  const config = {
    ...rest,
    ...(list && { tools: list.map((t) => TOOL_ALIASES[t] ?? t) }),
    ...(instructions && { instructions }),
  } as AgentConfig;
  return { kind: 'agent', name: fileName, config };
}

export async function loadAgentDir(dir: string): Promise<Array<ParsedFile & { path: string }>> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.md')).sort();
  return Promise.all(
    files.map(async (file) => {
      const path = join(dir, file);
      try {
        return { ...parseAgentFile(await readFile(path, 'utf8'), basename(file, '.md')), path };
      } catch (err) {
        throw new Error(`${path}: ${(err as Error).message}`);
      }
    }),
  );
}

/** Adds agents from Markdown files; explicitly configured JSON agents with the same name are an error. */
export async function withAgentFiles(config: HarnessConfig, baseDir: string, dirs?: string[]): Promise<HarnessConfig> {
  const configured = config.agentsDir === undefined ? undefined : Array.isArray(config.agentsDir) ? config.agentsDir : [config.agentsDir];
  const list = dirs ?? configured ?? DEFAULT_AGENT_DIRS;
  const agents: Record<string, AgentConfig> = { ...config.agents };
  const teams: Record<string, TeamConfig> = { ...config.teams };
  for (const dir of list) {
    const abs = resolve(baseDir, expandHome(dir));
    if (!existsSync(abs)) {
      if (dirs || configured) throw new Error(`agents directory not found: ${abs}`);
      continue;
    }
    for (const file of await loadAgentDir(abs)) {
      if (agents[file.name] || teams[file.name]) throw new Error(`"${file.name}" is defined twice (${file.path})`);
      if (file.kind === 'team') teams[file.name] = file.config;
      else agents[file.name] = file.config;
    }
  }
  return { ...config, agents, teams };
}
