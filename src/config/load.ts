import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { McpServerConfig } from '../mcp/client.ts';
import { withAgentFiles } from '../agentfile.ts';
import { MODEL_ALIASES, PRESETS, type PresetOverrides, splitModel } from '../presets.ts';
import { validate } from '../schema.ts';
import type { Budget, JsonSchema, ModelParams, PolicyConfig, Pricing, Risk } from '../types.ts';
import { checkLimit, forEachLimit, limitAt, limitRange, limitWarning } from '../limits.ts';
import type { ServeSettings } from '../serve.ts';
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
  asTool?: { name?: string; description: string; context?: 'fresh' | 'fork'; forwardEvents?: boolean };
  /** Set to false to bypass the global response cache for this agent. */
  responseCache?: boolean;
  /** Name of a router under `routers` that picks the model per request (`model` stays the default model). */
  router?: string;
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
  /** Settings for built-in presets used as `"<preset>/<model>"`, e.g. extra request headers. */
  presets?: Record<string, PresetOverrides>;
  models?: Record<string, { provider: string; model: string; params?: ModelParams; pricing?: Pricing; fallback?: string[] }>;
  /** Per-model price overrides (USD per million tokens), keyed by model id and merged over the built-in table. */
  pricing?: Record<string, Partial<Pricing>>;
  mcpServers?: Record<string, McpServerConfig>;
  /**
   * Workspace root and execution limits. In JSON, every limit also takes `${env:NAME}` and, where allowed, `"unbounded"`
   * (Infinity in code); see `LIMITS`.
   */
  tools?: {
    workspace?: string;
    concurrency?: number;
    timeoutMs?: number;
    maxResultChars?: number;
    shellTimeoutMs?: number;
    shellMaxOutputChars?: number;
    shellExitGraceMs?: number;
    maxWalkFiles?: number;
    maxFindResults?: number;
    searchMaxResults?: number;
    searchMaxFileBytes?: number;
    searchLineChars?: number;
    artifactReadChars?: number;
    skillMaxFileBytes?: number;
    skillDescriptionChars?: number;
    artifacts?: 'none' | 'memory' | 'file';
  };
  policy?: PolicyConfig;
  /** Inbound token verification and outbound credentials; `type` names a factory a plugin registered. */
  identity?: IdentityConfig;
  store?: ComponentConfig;
  sinks?: ComponentConfig[];
  agents?: Record<string, AgentConfig>;
  teams?: Record<string, TeamConfig>;
  responseCache?: ComponentConfig & { ttlMs?: number; namespace?: string; maxEntries?: number };
  /** In-process model routers by name (`{ "type": <registered router>, ...options }`), used by agents' `router`. */
  routers?: Record<string, ComponentConfig>;
  memory?: { type?: 'file' | 'memory'; dir?: string; scope?: 'shared' | 'agent'; namespace?: string; recallLimit?: number };
  /** Provider-hosted tools by tool name (e.g. Anthropic `web_search_20250305`), usable in agents' `tools`. */
  hostedTools?: Record<string, HostedToolConfig>;
  /** Settings of the built-in `web_search` / `web_fetch` tools. */
  web?: WebConfig;
  /** Settings of the public-signal tools (`search_discussions`, `search_projects`, `search_questions`, `search_papers`). */
  signals?: SignalsConfig;
  /** Limits of `reinloop serve` (options passed to `serve()` win). */
  serve?: ServeSettings;
  /** Cross-cutting limits: run loop and redaction. */
  limits?: LimitsConfig;
  profiles?: Record<string, Partial<HarnessConfig>>;
}

export interface LimitsConfig {
  /** Turns of an agent that sets no `budget` (default 50; `"unbounded"` allowed, with a warning). */
  maxTurns?: number;
  /** Empty model responses in a row before a run fails (default 2). */
  maxEmptyResponses?: number;
  /** Shorter secrets are not masked in echoed error text (default 4). */
  minSecretChars?: number;
}

export interface IdentityConfig {
  verifier?: { type: string; [option: string]: unknown };
  credentials?: { type: string; [option: string]: unknown };
  /** `reinloop serve`: reject /v1 requests without a valid bearer token (default true when a verifier is set). */
  required?: boolean;
}

export interface HostedToolConfig {
  provider: string;
  type: string;
  params?: Record<string, unknown>;
  risk?: Risk;
  description?: string;
  limitParam?: string;
  beta?: string;
}

export interface WebConfig {
  provider?: 'tavily' | 'anthropic-native';
  /** Tavily API key (default env TAVILY_API_KEY). */
  apiKey?: string;
  /** `anthropic-native`: model running the hosted search (default `anthropic/claude-haiku-5-5`). */
  model?: string;
  maxUses?: number;
  maxResults?: number;
  maxResultsCap?: number;
  maxChars?: number;
  maxFetchChars?: number;
  cacheTtlMs?: number;
  fetchPolicy?: 'search-results' | 'any' | 'off';
  maxUrlLength?: number;
  cacheMaxEntries?: number;
  maxTrackedRuns?: number;
  searchDepth?: 'basic' | 'advanced';
  topic?: 'general' | 'news';
  includeDomains?: string[];
  excludeDomains?: string[];
}

export interface SignalsConfig {
  /** Enabled sources (default all): `hackernews`, `github`, `stackoverflow`, `arxiv`. */
  sources?: Array<'hackernews' | 'github' | 'stackoverflow' | 'arxiv'>;
  maxResults?: number;
  maxResultsCap?: number;
  maxChars?: number;
  cacheTtlMs?: number;
  cacheMaxEntries?: number;
  timeoutMs?: number;
  errorBodyChars?: number;
  rateLimitBodyChars?: number;
  /** GitHub token (default env GITHUB_TOKEN); use `${env:NAME}` rather than a literal. */
  githubToken?: string;
  githubIssues?: boolean;
  stackExchangeSite?: string;
  userAgent?: string;
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

/**
 * Replaces `${env:NAME}` and `${env:NAME:-default}` in every string of `value`. A string at a limit path (see `LIMITS`)
 * becomes a number afterwards: digits are parsed and `"unbounded"` becomes Infinity, then the range is checked. `owner` is
 * the `type` of the enclosing component, for limits that apply to some component types only.
 */
export function interpolate<T>(value: T, env: Env, path = '$', owner?: string): T {
  if (typeof value === 'string') {
    const out = value.replace(PLACEHOLDER, (_, name: string, fallback: string | undefined) => {
      const v = env[name];
      if (v !== undefined && v !== '') return v;
      if (fallback !== undefined) return fallback;
      throw new ConfigError(`${path}: environment variable ${name} is not set`);
    });
    const limit = path.startsWith('$.') ? limitAt(path, owner) : undefined;
    if (!limit) return out as T;
    const checked = checkLimit(limit.spec, out);
    // The resolved text of a placeholder is not echoed: an environment value is not always meant to be printed.
    if ('error' in checked) throw new ConfigError(`${path}: ${out === value ? checked.error : `the value of ${value} ${checked.error}`}`);
    return checked.value as T;
  }
  if (Array.isArray(value)) return value.map((v, i) => interpolate(v, env, `${path}[${i}]`, owner)) as T;
  if (isObject(value)) {
    const type = typeof value.type === 'string' ? value.type : owner;
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, env, `${path}.${k}`, type)])) as T;
  }
  return value;
}

/** Like `interpolate`, but only for limit fields (see `LIMITS`): every other value is returned as it is. */
export function resolveLimits<T>(value: T, env: Env, path = '$', owner?: string): T {
  if (typeof value === 'string') return path.startsWith('$.') && limitAt(path, owner) ? interpolate(value, env, path, owner) : value;
  if (Array.isArray(value)) return value.map((v, i) => resolveLimits(v, env, `${path}[${i}]`, owner)) as T;
  if (isObject(value)) {
    const type = typeof value.type === 'string' ? value.type : owner;
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveLimits(v, env, `${path}.${k}`, type)])) as T;
  }
  return value;
}

const unresolvable = (s: string, env: Env) => [...s.matchAll(PLACEHOLDER)].some(([, name, fallback]) => (env[name!] === undefined || env[name!] === '') && fallback === undefined);

/**
 * Range checks of every limit in `config`. Without `env`, placeholders are accepted as they are (they are checked when
 * the component is built); with `env`, they are resolved where the variables are set and checked too. Warnings flag
 * unsafe values: `"unbounded"` where that turns off a protection, and values outside the safe range.
 */
export function checkLimits(config: HarnessConfig, env?: Env): { errors: Array<{ path: string; message: string }>; warnings: string[] } {
  const errors: Array<{ path: string; message: string }> = [];
  const warnings: string[] = [];
  forEachLimit(config, (path, raw, spec, owner) => {
    let value = raw;
    if (typeof raw === 'string' && raw.includes('${')) {
      if (!env || unresolvable(raw, env)) return;
      try {
        value = interpolate(raw, env, path, owner);
      } catch (err) {
        errors.push({ path, message: (err as Error).message });
        return;
      }
    } else if (typeof raw === 'string' && raw !== 'unbounded') {
      errors.push({ path, message: `${path}: must be a number, ${spec.unbounded ? '"unbounded", ' : ''}or a \${env:NAME} placeholder (accepted: ${limitRange(spec)})` });
      return;
    }
    const checked = checkLimit(spec, value);
    if ('error' in checked) {
      errors.push({ path, message: `${path}: ${checked.error}` });
      return;
    }
    const warning = limitWarning(spec, checked.value, path);
    if (warning) warnings.push(warning);
  });
  return { errors, warnings };
}

/** Load-time warnings for unsafe limit values (`"unbounded"` protections, values outside the safe range). */
export function limitWarnings(config: HarnessConfig, env: Env = process.env): string[] {
  return checkLimits(config, env).warnings;
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

/** Where layer implementations live; reinloop keeps the hooks they plug into. */
export const LAYERS_HOME = 'agent-layers (https://github.com/aantenore/agent-layers)';

/** Top-level keys of layer implementations that moved out of reinloop, with the hook that remains. */
const MOVED: Readonly<Record<string, string>> = {
  knowledge: 'knowledge sources are agent-layers adapters; reinloop keeps the KnowledgeSource hook (knowledgeMiddleware)',
  guardrails: 'guard adapters are agent-layers adapters; reinloop keeps the Guard hook (guardMiddleware)',
  httpTools: 'declarative HTTP tools are an agent-layers adapter; register tools from a plugin instead',
  openapi: 'OpenAPI import is an agent-layers adapter; register tools from a plugin instead',
};

/** Structural (JSON Schema) and referential checks. Returns the list of problems. */
export function checkConfig(config: HarnessConfig): string[] {
  // Limit fields get precise messages from their descriptor; the schema's generic "does not match" for them is dropped.
  const limits = checkLimits(config).errors;
  const limitPaths = new Set(limits.map((e) => e.path));
  const moved = Object.keys(MOVED).filter((k) => k in (config as object));
  const movedPath = (e: string) => moved.some((k) => e === `$.${k}: unknown property` || e.startsWith(`$.${k}.`) || e.startsWith(`$.${k}[`));
  const errors = [
    ...moved.map((k) => `$.${k}: no longer part of reinloop: ${MOVED[k]} (see ${LAYERS_HOME})`),
    ...validate(CONFIG_SCHEMA, config).filter((e) => !limitPaths.has(e.slice(0, e.indexOf(': '))) && !movedPath(e)),
    ...limits.map((e) => e.message),
  ];
  if (errors.length) return errors;
  const providers = config.providers ?? {};
  const models = config.models ?? {};
  for (const name of Object.keys(config.presets ?? {})) {
    if (!PRESETS[name]) errors.push(`$.presets.${name}: unknown preset (built-in: ${Object.keys(PRESETS).join(', ')})`);
  }
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
  const checkRouter = (ref: string | undefined, path: string) => {
    if (ref !== undefined && !ref.includes('${') && !config.routers?.[ref]) errors.push(`${path}: unknown router "${ref}"`);
  };
  for (const [name, a] of Object.entries(agents)) checkRouter(a.router, `$.agents.${name}.router`);
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

export interface LoadedConfig {
  config: HarnessConfig;
  path: string;
  baseDir: string;
  /** Unsafe limit values found at load (also emitted as process warnings unless `onWarning` is given). */
  warnings: string[];
}

export interface LoadConfigOptions {
  profile?: string;
  env?: Env;
  agentsDir?: string[];
  /** Receives each load-time warning; default `process.emitWarning` (type `ReinloopConfigWarning`). */
  onWarning?: (message: string) => void;
}

const emitConfigWarning = (message: string) => process.emitWarning(message, { type: 'ReinloopConfigWarning', code: 'REINLOOP_UNSAFE_LIMIT' });

/** Reads a JSON config with `extends` layering and an optional profile overlay, then validates it. */
export async function loadConfig(path: string, opts: LoadConfigOptions = {}): Promise<LoadedConfig> {
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
  // Placeholders whose variables are set are resolved and range-checked now; unset ones fail when their component is built.
  const limits = checkLimits(config, env);
  for (const e of limits.errors) if (!errors.includes(e.message)) errors.push(e.message);
  if (errors.length) throw new ConfigError(`invalid config ${abs}:\n  ${errors.join('\n  ')}`);
  for (const w of limits.warnings) (opts.onWarning ?? emitConfigWarning)(w);
  return { config, path: abs, baseDir: dirname(abs), warnings: limits.warnings };
}
