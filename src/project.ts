import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { withAgentFiles } from './agentfile.ts';
import { type AgentConfig, applyProfile, ConfigError, type Env, type HarnessConfig, checkConfig, loadConfig } from './config/load.ts';
import { createRuntime, loadPlugins, type Runtime } from './config/runtime.ts';
import { createRegistry, type Registry } from './registry.ts';

export const CONFIG_FILE = 'reinloop.json';

/** Used only when a project defines no agent at all, so `reinloop run "..."` works in any folder. */
export const DEFAULT_AGENT: AgentConfig = {
  description: 'General assistant with read-only access to the current folder',
  instructions: 'You are a precise, concise assistant. Inspect the workspace with your tools when it helps; never guess file contents.',
  tools: ['read_file', 'list_dir', 'find_files', 'search_files'],
};

export interface ProjectOptions {
  /** Config file; default `reinloop.json` in `cwd` when present. */
  config?: string;
  /** Agent directories; default `agents/` and `.reinloop/agents/` when present. */
  agentsDir?: string[];
  profile?: string;
  env?: Env;
  cwd?: string;
  registry?: Registry;
}

/** Convention over configuration: config file optional, Markdown agents discovered, sensible default agent. */
export async function loadProject(opts: ProjectOptions = {}): Promise<Runtime> {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const env = opts.env ?? process.env;
  const configPath = opts.config ? resolve(cwd, opts.config) : existsSync(join(cwd, CONFIG_FILE)) ? join(cwd, CONFIG_FILE) : undefined;
  let config: HarnessConfig;
  let baseDir = cwd;
  if (configPath) {
    const loaded = await loadConfig(configPath, { profile: opts.profile, env, agentsDir: opts.agentsDir });
    config = loaded.config;
    baseDir = loaded.baseDir;
  } else {
    try {
      config = await withAgentFiles(applyProfile({}, opts.profile ?? env.REINLOOP_PROFILE), cwd, opts.agentsDir);
    } catch (err) {
      throw new ConfigError((err as Error).message);
    }
  }
  if (!Object.keys(config.agents ?? {}).length && !Object.keys(config.teams ?? {}).length) config = { ...config, agents: { assistant: DEFAULT_AGENT } };
  const errors = checkConfig(config);
  if (errors.length) throw new ConfigError(`invalid agents:\n  ${errors.join('\n  ')}`);
  const registry = opts.registry ?? createRegistry();
  await loadPlugins(config.plugins ?? [], registry, baseDir);
  return createRuntime(config, { registry, env, baseDir });
}
