import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type CacheStore, withResponseCache } from '../cache.ts';
import type { RunHandle } from '../loop.ts';
import { McpClient, mcpTools } from '../mcp/client.ts';
import { createTeam } from '../patterns.ts';
import { mergePolicies } from '../policy.ts';
import { defaultModel, MODEL_ALIASES, resolveModel, splitModel } from '../presets.ts';
import { withFallback } from '../providers/resilient.ts';
import { createRegistry, type FactoryContext, type Registry } from '../registry.ts';
import { fileArtifacts } from '../store/file.ts';
import { agentTool } from '../subagent.ts';
import { type Member, streamMember } from '../team.ts';
import { memoryArtifacts, readArtifactTool } from '../tools/define.ts';
import type { Agent, ArtifactStore, Message, ModelRef, Provider, RunOptions, RunResult, RunStore, Sink, Tool } from '../types.ts';
import { globToRegExp } from '../util.ts';
import { type AgentConfig, ConfigError, type Env, type HarnessConfig, checkConfig, interpolate, loadConfig } from './load.ts';

export interface RuntimeOptions {
  registry?: Registry;
  env?: Env;
  /** Directory relative paths (instructions files, stores, workspace) resolve against. */
  baseDir?: string;
}

export interface Runtime {
  readonly config: HarnessConfig;
  readonly registry: Registry;
  readonly store: RunStore;
  readonly sinks: Sink[];
  /** Names of every runnable member (agents and teams). */
  names(): string[];
  /** Builds (once) and returns an agent or team by name; defaults to `defaultAgent` or the only one defined. */
  agent(name?: string): Promise<Member>;
  stream(name: string | undefined, input?: string | Message[], opts?: RunOptions): Promise<RunHandle>;
  run(name: string | undefined, input?: string | Message[], opts?: RunOptions): Promise<RunResult>;
  close(): Promise<void>;
}

/** Loads plugins listed in the config; each module exports `default(registry)` or `register(registry)`. */
export async function loadPlugins(specs: string[], registry: Registry, baseDir: string): Promise<void> {
  for (const spec of specs) {
    const target = spec.startsWith('.') || isAbsolute(spec) ? pathToFileURL(resolve(baseDir, spec)).href : spec;
    const mod = await import(target);
    const register = mod.default ?? mod.register;
    if (typeof register !== 'function') throw new ConfigError(`plugin ${spec} must export default(registry) or register(registry)`);
    await register(registry);
  }
}

/** Loads a config file (plus agent files and plugins) and builds a runtime. */
export async function loadRuntime(path: string, opts: RuntimeOptions & { profile?: string; agentsDir?: string[] } = {}): Promise<Runtime> {
  const { config, baseDir } = await loadConfig(path, { profile: opts.profile, env: opts.env, agentsDir: opts.agentsDir });
  const registry = opts.registry ?? createRegistry();
  await loadPlugins(config.plugins ?? [], registry, baseDir);
  return createRuntime(config, { ...opts, registry, baseDir });
}

/** Builds agents and teams lazily from a validated config object. Components are created once and shared. */
export async function createRuntime(config: HarnessConfig, opts: RuntimeOptions = {}): Promise<Runtime> {
  const errors = checkConfig(config);
  if (errors.length) throw new ConfigError(`invalid config:\n  ${errors.join('\n  ')}`);
  const registry = opts.registry ?? createRegistry();
  const env = opts.env ?? process.env;
  const baseDir = opts.baseDir ?? process.cwd();
  const toolCfg = interpolate(config.tools ?? {}, env, '$.tools');
  const singletons = new Map<string, unknown>();
  const ctx: FactoryContext = {
    baseDir,
    env,
    config,
    workspace: resolve(baseDir, toolCfg.workspace ?? '.'),
    shellTimeoutMs: toolCfg.shellTimeoutMs,
    once: <T>(key: string, create: () => T): T => {
      if (!singletons.has(key)) singletons.set(key, create());
      return singletons.get(key) as T;
    },
  };

  const make = async <T>(kind: string, map: Map<string, (o: any, c: FactoryContext) => T | Promise<T>>, spec: { type: string }, path: string): Promise<T> => {
    const factory = map.get(spec.type);
    if (!factory) throw new ConfigError(`${path}.type: unknown ${kind} "${spec.type}" (registered: ${[...map.keys()].join(', ')})`);
    const { type: _, ...options } = interpolate(spec, env, path) as Record<string, unknown>;
    return factory(options, ctx);
  };

  const store = config.store ? await make('store', registry.stores, config.store, '$.store') : await registry.stores.get('memory')!({}, ctx);
  const sinks = await Promise.all((config.sinks ?? []).map((s, i) => make('sink', registry.sinks, s, `$.sinks[${i}]`)));
  const artifacts: ArtifactStore | undefined =
    toolCfg.artifacts === 'none' ? undefined : toolCfg.artifacts === 'file' ? fileArtifacts(resolve(baseDir, '.reinloop/artifacts')) : memoryArtifacts();
  const responseCache: CacheStore | undefined = config.responseCache
    ? await make('cache', registry.caches, config.responseCache, '$.responseCache')
    : undefined;

  const providers = new Map<string, Promise<Provider>>();
  const provider = (name: string) => {
    if (!providers.has(name)) providers.set(name, make('provider', registry.providers, config.providers![name]!, `$.providers.${name}`));
    return providers.get(name)!;
  };

  // Resolution order: `models` alias, short alias (sonnet...), "<configured provider>/<model>", built-in preset.
  const modelRef = async (spec: string | undefined): Promise<ModelRef> => {
    const chosen = spec === undefined || spec === 'inherit' ? interpolate(config.defaultModel ?? defaultModel(env), env, '$.defaultModel') : spec;
    const configured = config.models?.[chosen];
    if (configured) {
      const m = interpolate(configured, env, `$.models.${chosen}`);
      const ref: ModelRef = { provider: await provider(m.provider), model: m.model, params: m.params, pricing: m.pricing };
      if (!m.fallback?.length) return ref;
      const chain = [ref, ...(await Promise.all(m.fallback.map(modelRef)))];
      return { ...ref, provider: withFallback(chain) };
    }
    const full = MODEL_ALIASES[chosen] ?? chosen;
    const parts = splitModel(full);
    if (!parts) throw new ConfigError(`unknown model "${chosen}"`);
    if (config.providers?.[parts.provider]) return { provider: await provider(parts.provider), model: parts.model };
    return resolveModel(full, env);
  };

  const mcp = new Map<string, Promise<{ client: McpClient; tools: Tool[] }>>();
  const serverTools = (server: string) => {
    if (!mcp.has(server)) mcp.set(server, mcpTools(server, interpolate(config.mcpServers![server]!, env, `$.mcpServers.${server}`)));
    return mcp.get(server)!.then((s) => s.tools);
  };
  const serverFor = (pattern: string): string | undefined => {
    if (pattern.startsWith('mcp:')) return pattern.slice(4);
    const prefix = pattern.split('__')[0]!;
    return Object.entries(config.mcpServers ?? {}).find(([name, s]) => (s.prefix ?? name) === prefix && pattern.includes('__'))?.[0];
  };

  const agentDefs = config.agents ?? {};
  const teamDefs = config.teams ?? {};
  const built = new Map<string, Promise<Member>>();

  const resolveTools = async (owner: string, patterns: string[], stack: string[]): Promise<Tool[]> => {
    const byName = new Map<string, Tool>();
    for (const pattern of patterns) {
      const server = serverFor(pattern);
      if (server !== undefined) {
        if (!config.mcpServers?.[server]) throw new ConfigError(`$.agents.${owner}.tools: unknown MCP server "${server}"`);
        const all = await serverTools(server);
        const re = pattern.startsWith('mcp:') ? /.*/ : globToRegExp(pattern);
        const hits = all.filter((t) => re.test(t.name));
        if (!hits.length) throw new ConfigError(`$.agents.${owner}.tools: "${pattern}" matches no tool of MCP server "${server}"`);
        for (const t of hits) byName.set(t.name, t);
        continue;
      }
      const re = globToRegExp(pattern);
      let matched = false;
      for (const name of registry.tools.keys()) {
        if (!re.test(name)) continue;
        matched = true;
        byName.set(name, await registry.tools.get(name)!({}, ctx));
      }
      // Agents and teams become tools. Exact references always work; globs only pick members that describe themselves.
      const members: Array<[string, { description?: string; asTool?: AgentConfig['asTool'] }]> = [...Object.entries(agentDefs), ...Object.entries(teamDefs)];
      for (const [name, def] of members) {
        const toolName = def.asTool?.name ?? name;
        if (name === owner || !re.test(toolName) || (!def.asTool && !def.description && pattern !== toolName)) continue;
        matched = true;
        const member = await build(name, stack);
        const description = def.asTool?.description ?? member.description ?? `Delegate a task to ${name}`;
        byName.set(toolName, agentTool(member, { name: toolName, description, context: def.asTool?.context }));
      }
      if (pattern === 'read_artifact' && artifacts) {
        matched = true;
        byName.set('read_artifact', readArtifactTool(artifacts));
      }
      if (!matched) throw new ConfigError(`$.agents.${owner}.tools: "${pattern}" matches no registered tool, agent or team`);
    }
    return [...byName.values()];
  };

  const buildAgent = async (name: string, a: AgentConfig, stack: string[]): Promise<Agent> => {
    const model = await modelRef(a.model);
    if (a.params) model.params = { ...model.params, ...a.params };
    if (responseCache && a.responseCache !== false) {
      const { ttlMs, namespace } = config.responseCache as { ttlMs?: number; namespace?: string };
      model.provider = withResponseCache(model.provider, responseCache, { ttlMs, namespace });
    }
    const tools = await resolveTools(name, a.tools ?? [], stack);
    const instructions = a.instructions?.startsWith('file:') ? await readFile(resolve(baseDir, a.instructions.slice(5)), 'utf8') : a.instructions;
    const middleware = await Promise.all(
      (a.middleware ?? []).map((m, i) => make('middleware', registry.middleware, { type: m }, `$.agents.${name}.middleware[${i}]`)),
    );
    return {
      name,
      description: a.description ?? a.asTool?.description,
      model,
      instructions,
      tools,
      policy: mergePolicies(config.policy, a.policy),
      budget: a.budget,
      compaction: a.compaction && {
        strategy: await make('compaction strategy', registry.compaction, a.compaction, `$.agents.${name}.compaction`),
        thresholdTokens: a.compaction.thresholdTokens,
      },
      output: a.output,
      middleware,
      toolSettings: {
        concurrency: toolCfg.concurrency,
        timeoutMs: toolCfg.timeoutMs,
        maxResultChars: toolCfg.maxResultChars,
        artifacts: tools.some((t) => t.name === 'read_artifact') ? artifacts : undefined,
      },
    };
  };

  const buildTeam = async (name: string, stack: string[]): Promise<Member> => {
    const t = teamDefs[name]!;
    const pattern = registry.patterns.get(t.pattern);
    if (!pattern) throw new ConfigError(`$.teams.${name}.pattern: unknown pattern "${t.pattern}" (registered: ${[...registry.patterns.keys()].join(', ')})`);
    const roles: Record<string, Member | Member[]> = {};
    for (const [role, binding] of Object.entries(t.roles)) {
      const refs = Array.isArray(binding) ? binding : [binding];
      const members = await Promise.all(
        refs.map((ref, i) => {
          if (typeof ref === 'string') return build(ref, stack);
          const inlineName = `${name}-${role}${refs.length > 1 ? `-${i + 1}` : ''}`;
          return buildAgent(inlineName, ref, [...stack, inlineName]);
        }),
      );
      roles[role] = Array.isArray(binding) ? members : members[0]!;
    }
    try {
      return createTeam(name, pattern, t.pattern, roles, t.options, t.description);
    } catch (err) {
      throw new ConfigError((err as Error).message);
    }
  };

  const build = (name: string, stack: string[] = []): Promise<Member> => {
    if (stack.includes(name)) return Promise.reject(new ConfigError(`cycle: ${[...stack, name].join(' -> ')}`));
    if (!built.has(name)) {
      const next = [...stack, name];
      const promise = agentDefs[name]
        ? buildAgent(name, agentDefs[name], next)
        : teamDefs[name]
          ? buildTeam(name, next)
          : Promise.reject(new ConfigError(`unknown agent or team "${name}" (available: ${names().join(', ') || 'none'})`));
      built.set(name, promise);
      promise.catch(() => built.delete(name));
    }
    return built.get(name)!;
  };

  const names = () => [...Object.keys(agentDefs), ...Object.keys(teamDefs)];

  const pick = (name?: string) => {
    const all = names();
    const chosen = name ?? config.defaultAgent ?? (all.length === 1 ? all[0] : undefined);
    if (!chosen) return Promise.reject(new ConfigError(all.length ? `several agents defined (${all.join(', ')}): pass a name or set "defaultAgent"` : 'no agents defined'));
    return build(chosen);
  };

  const withDefaults = (o: RunOptions = {}): RunOptions => ({ ...o, store: o.store ?? store, sinks: o.sinks ?? sinks });
  const start = async (name: string | undefined, input?: string | Message[], o?: RunOptions) => streamMember(await pick(name), input, withDefaults(o));

  return {
    config,
    registry,
    store,
    sinks,
    names,
    agent: pick,
    stream: start,
    async run(name, input, o) {
      return (await start(name, input, o)).result;
    },
    async close() {
      const servers = await Promise.allSettled(mcp.values());
      await Promise.allSettled(servers.map((s) => (s.status === 'fulfilled' ? s.value.client.close() : undefined)));
      await Promise.allSettled(sinks.map((s) => s.close?.()));
    },
  };
}
