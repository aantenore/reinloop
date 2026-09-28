import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { McpServerConfig } from '../mcp/client.ts';
import { withAgentFiles } from '../agentfile.ts';
import { MODEL_ALIASES, PRESETS, splitModel } from '../presets.ts';
import { validate } from '../schema.ts';
import type { Budget, JsonSchema, ModelParams, PolicyConfig, Pricing } from '../types.ts';
import { ReinloopError } from '../util.ts';
import { CONFIG_SCHEMA } from './schema.ts';

export interface ComponentConfig { type: string; [option: string]: unknown }

export interface AgentConfig {
  description?: string;
  /** Model alias from `models`, `"provider/model"`, `inherit`, or omitted for the default model. */
  model?: string;
  instructions?: string;
  tools?: string[];
  params?: ModelParams;
  policy?: PolicyConfig;
  budget?: Budget;
  compaction?: ComponentConfig & { thresholdTokens: number };
  output?: { schema: JsonSchema; retries?: number };
  middleware?: string[];
  asTool?: { name?: string; description: string; context?: 'fresh' | 'fork' };
  /** Set to false to bypass the global response cache for this agent. */
  responseCache?: boolean;
  /** Agent Skills (names or globs) this agent may load. */
  skills?: string[];
}

/** A role is filled by an agent/team name, an inline agent definition, or a list of them. */
export type RoleBinding = string | AgentConfig | Array<string | AgentConfig>;

export interface TeamConfig {
  pattern: string;
  description?: string;
  roles: Record<string, RoleBinding>;
  options?: Record<string, unknown>;
}

export interface HarnessConfig {
  $schema?: string;
  extends?: string | string[];
  plugins?: string[];
  defaultAgent?: string;
  /** Model for agents that do not name one (default: REINLOOP_MODEL or auto-detected from API keys). */
  defaultModel?: string;
  /** Directories with Markdown agent files (default: agents/ and .reinloop/agents/ when present). */
  agentsDir?: string | string[];
  /** Directories with Agent Skills (folders containing SKILL.md); default skills/ and .reinloop/skills/. */
  skillsDir?: string | string[];
  providers?: Record<string, ComponentConfig>;
  models?: Record<string, { provider: string; model: string; params?: ModelParams; pricing?: Pricing; fallback?: string[] }>;
  mcpServers?: Record<string, McpServerConfig>;
  tools?: {
    workspace?: string;
    concurrency?: number;
    timeoutMs?: number;
    maxResultChars?: number;
    shellTimeoutMs?: number;
    artifacts?: 'none' | 'memory' | 'file';
  };
  policy?: PolicyConfig;
  store?: ComponentConfig;
  sinks?: ComponentConfig[];
  agents?: Record<string, AgentConfig>;
  teams?: Record<string, TeamConfig>;
  responseCache?: ComponentConfig & { ttlMs?: number; namespace?: string };
  memory?: { type?: 'file' | 'memory'; dir?: string; scope?: 'shared' | 'agent'; namespace?: string };
  profiles?: Record<string, Partial<HarnessConfig>>;
}

export class ConfigError extends ReinloopError {
  constructor(message: string) {
    super('config_error', message);
    this.name = 'ConfigError';
  }
}

export type Env = Record<string, string | undefined>;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Objects merge recursively; arrays and scalars from `over` replace those in `base`. */
export function deepMerge<T>(base: T, over: unknown): T {
  if (!isObject(base) || !isObject(over)) return (over === undefined ? base : over) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = deepMerge(out[k], v);
  return out as T;
}

const PLACEHOLDER = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/** Replaces `${env:NAME}` and `${env:NAME:-default}` in every string of `value`. */
export function interpolate<T>(value: T, env: Env, path = '$'): T {
  if (typeof value === 'string') {
    return value.replace(PLACEHOLDER, (_, name: string, fallback: string | undefined) => {
      const v = env[name];
      if (v !== undefined && v !== '') return v;
      if (fallback !== undefined) return fallback;
      throw new ConfigError(`${path}: environment variable ${name} is not set`);
    }) as T;
  }
  if (Array.isArray(value)) return value.map((v, i) => interpolate(v, env, `${path}[${i}]`)) as T;
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, env, `${path}.${k}`)])) as T;
  }
  return value;
}

async function readLayered(path: string, seen: string[]): Promise<Record<string, unknown>> {
  const abs = resolve(path);
  if (seen.includes(abs)) throw new ConfigError(`circular "extends": ${[...seen, abs].join(' -> ')}`);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(abs, 'utf8'));
  } catch (err) {
    throw new ConfigError(`cannot read config ${abs}: ${(err as Error).message}`);
  }
  if (!isObject(raw)) throw new ConfigError(`${abs}: config must be a JSON object`);
  const parents = raw.extends === undefined ? [] : Array.isArray(raw.extends) ? raw.extends : [raw.extends];
  let merged: Record<string, unknown> = {};
  for (const parent of parents as string[]) merged = deepMerge(merged, await readLayered(resolve(dirname(abs), parent), [...seen, abs]));
  const { extends: _, ...own } = raw;
  return deepMerge(merged, own);
}

export function applyProfile(config: HarnessConfig, profile: string | undefined): HarnessConfig {
  if (!profile) return config;
  const overlay = config.profiles?.[profile];
  if (!overlay) throw new ConfigError(`unknown profile "${profile}" (available: ${Object.keys(config.profiles ?? {}).join(', ') || 'none'})`);
  return deepMerge(config, overlay);
}

/** Structural (JSON Schema) and referential checks. Returns the list of problems. */
export function checkConfig(config: HarnessConfig): string[] {
  const errors = validate(CONFIG_SCHEMA, config);
  if (errors.length) return errors;
  const providers = config.providers ?? {};
  const models = config.models ?? {};
  for (const [name, m] of Object.entries(models)) {
    if (!providers[m.provider]) errors.push(`$.models.${name}.provider: unknown provider "${m.provider}"`);
    for (const fb of m.fallback ?? []) if (!models[fb]) errors.push(`$.models.${name}.fallback: unknown model "${fb}"`);
  }
  const agents = config.agents ?? {};
  const checkModel = (spec: string | undefined, path: string) => {
    // Placeholders are resolved (and checked) when the agent is built.
    if (spec === undefined || spec === 'inherit' || spec.includes('${') || models[spec] || MODEL_ALIASES[spec]) return;
    const parts = splitModel(spec);
    if (!parts) errors.push(`${path}: unknown model "${spec}" (use a "models" alias or "provider/model")`);
    else if (!providers[parts.provider] && !PRESETS[parts.provider]) errors.push(`${path}: unknown provider "${parts.provider}" in "${spec}"`);
  };
  checkModel(config.defaultModel, '$.defaultModel');
  for (const [name, a] of Object.entries(agents)) checkModel(a.model, `$.agents.${name}.model`);
  const teams = config.teams ?? {};
  for (const name of Object.keys(teams)) if (agents[name]) errors.push(`$.teams.${name}: name already used by an agent`);
  for (const [name, t] of Object.entries(teams)) {
    for (const [role, binding] of Object.entries(t.roles)) {
      for (const [i, ref] of (Array.isArray(binding) ? binding : [binding]).entries()) {
        const path = `$.teams.${name}.roles.${role}${Array.isArray(binding) ? `[${i}]` : ''}`;
        if (typeof ref === 'string' && !agents[ref] && !teams[ref]) errors.push(`${path}: unknown agent or team "${ref}"`);
        if (typeof ref === 'object') checkModel(ref.model, `${path}.model`);
      }
    }
  }
  if (config.defaultAgent && !agents[config.defaultAgent] && !teams[config.defaultAgent]) {
    errors.push(`$.defaultAgent: unknown agent or team "${config.defaultAgent}"`);
  }
  return errors;
}

export interface LoadedConfig { config: HarnessConfig; path: string; baseDir: string }

/** Reads a JSON config with `extends` layering and an optional profile overlay, then validates it. */
export async function loadConfig(path: string, opts: { profile?: string; env?: Env; agentsDir?: string[] } = {}): Promise<LoadedConfig> {
  const abs = resolve(path);
  const env = opts.env ?? process.env;
  const layered = (await readLayered(abs, [])) as unknown as HarnessConfig;
  const profiled = applyProfile(layered, opts.profile ?? env.REINLOOP_PROFILE);
  let config: HarnessConfig;
  try {
    config = await withAgentFiles(profiled, dirname(abs), opts.agentsDir);
  } catch (err) {
    throw new ConfigError((err as Error).message);
  }
  const errors = checkConfig(config);
  if (errors.length) throw new ConfigError(`invalid config ${abs}:\n  ${errors.join('\n  ')}`);
  return { config, path: abs, baseDir: dirname(abs) };
}
