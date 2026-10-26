import { resolve } from 'node:path';
import { type CacheStore, fileCache, memoryCache } from './cache.ts';
import { summarizeCompaction, windowCompaction } from './compaction.ts';
import { type Env, type HarnessConfig, interpolate } from './config/load.ts';
import { resolveModel } from './presets.ts';
import { signalTools } from './tools/signals.ts';
import { webTools } from './tools/web.ts';
import { BUILTIN_PATTERNS, type PatternDefinition } from './patterns.ts';
import { fileNotes, memoryNotes, memoryTools } from './tools/memory.ts';
import { otlpSink } from './observe/otlp.ts';
import { consoleSink, jsonlSink } from './observe/sinks.ts';
import { anthropic } from './providers/anthropic.ts';
import { mockProvider } from './providers/mock.ts';
import { openaiCompatible } from './providers/openai.ts';
import { type RetryOptions, withRetry } from './providers/resilient.ts';
import { fileStore } from './store/file.ts';
import { memoryStore } from './store/memory.ts';
import { workspaceTools } from './tools/node.ts';
import type { CompactionStrategy, Middleware, Provider, RunStore, Sink, Tool } from './types.ts';

export interface FactoryContext {
  baseDir: string;
  env: Env;
  /** Resolved workspace root for filesystem/shell tools. */
  workspace: string;
  shellTimeoutMs?: number;
  config: HarnessConfig;
  /** Per-runtime singleton, e.g. a store shared by several tools. */
  once<T>(key: string, create: () => T): T;
}

export type Factory<T> = (options: Record<string, any>, ctx: FactoryContext) => T | Promise<T>;

/** Named factories that turn config entries into components. Extend it from plugins. */
export class Registry {
  readonly providers = new Map<string, Factory<Provider>>();
  readonly stores = new Map<string, Factory<RunStore>>();
  readonly sinks = new Map<string, Factory<Sink>>();
  readonly compaction = new Map<string, Factory<CompactionStrategy>>();
  readonly middleware = new Map<string, Factory<Middleware>>();
  readonly tools = new Map<string, Factory<Tool>>();
  readonly caches = new Map<string, Factory<CacheStore>>();
  /** Multi-agent patterns (chain, parallel, router, evaluator, orchestrator, and your own). */
  readonly patterns = new Map<string, PatternDefinition>(Object.entries(BUILTIN_PATTERNS));

  /** Registers a ready-made tool under its own name. */
  tool(tool: Tool): this {
    this.tools.set(tool.name, () => tool);
    return this;
  }
}

function resilient(provider: Provider, retry: RetryOptions | false | undefined): Provider {
  return retry === false ? provider : withRetry(provider, retry ?? {});
}

export function createRegistry(): Registry {
  const r = new Registry();

  r.providers.set('openai-compatible', ({ retry, ...o }) => resilient(openaiCompatible(o), retry));
  r.providers.set('anthropic', ({ retry, ...o }) => resilient(anthropic(o), retry));
  r.providers.set('mock', (o) => mockProvider(o.responses ?? [], { loop: o.loop, name: o.name }));

  r.stores.set('memory', () => memoryStore());
  r.stores.set('file', (o, ctx) => fileStore(resolve(ctx.baseDir, o.dir ?? '.reinloop/runs')));

  r.sinks.set('console', (o) => consoleSink({ level: o.level }));
  r.sinks.set('otlp', (o) => otlpSink({ endpoint: o.endpoint ?? 'http://localhost:4318', headers: o.headers, serviceName: o.serviceName, captureContent: o.captureContent, intervalMs: o.intervalMs }));
  r.sinks.set('jsonl', (o, ctx) => jsonlSink(resolve(ctx.baseDir, o.dir ?? '.reinloop/traces'), { includeDeltas: o.includeDeltas }));

  r.compaction.set('window', (o) => windowCompaction(o));
  r.compaction.set('summarize', (o) => summarizeCompaction(o));

  r.caches.set('memory', (o) => memoryCache(o.maxEntries));
  r.caches.set('file', (o, ctx) => fileCache(resolve(ctx.baseDir, o.dir ?? '.reinloop/cache')));

  for (const name of ['read_file', 'list_dir', 'write_file', 'edit_file', 'find_files', 'search_files', 'shell']) {
    r.tools.set(name, (_o, ctx) => workspaceTools({ root: ctx.workspace, shellTimeoutMs: ctx.shellTimeoutMs })[name]!);
  }
  const notes = (ctx: FactoryContext) =>
    ctx.once('memory', () => {
      const m = ctx.config.memory ?? {};
      const store = m.type === 'memory' ? memoryNotes() : fileNotes(resolve(ctx.baseDir, m.dir ?? '.reinloop/memory'));
      return memoryTools({ store, scope: m.scope, namespace: m.namespace });
    });
  r.tools.set('remember', (_o, ctx) => notes(ctx).remember);
  r.tools.set('recall', (_o, ctx) => notes(ctx).recall);
  const web = (ctx: FactoryContext) =>
    ctx.once('web', () => {
      const w = interpolate(ctx.config.web ?? {}, ctx.env, '$.web');
      const native = w.provider === 'anthropic-native';
      return webTools({
        provider: w.provider ?? 'tavily',
        ...(!native && {
          tavily: { apiKey: w.apiKey, env: ctx.env, searchDepth: w.searchDepth, topic: w.topic, includeDomains: w.includeDomains, excludeDomains: w.excludeDomains },
        }),
        ...(native && {
          anthropic: {
            model: resolveModel(w.model ?? 'anthropic/claude-haiku-5-5', ctx.env),
            maxUses: w.maxUses,
            ...((w.includeDomains || w.excludeDomains) && {
              params: { ...(w.includeDomains && { allowed_domains: w.includeDomains }), ...(w.excludeDomains && { blocked_domains: w.excludeDomains }) },
            }),
          },
        }),
        maxResults: w.maxResults,
        maxResultsCap: w.maxResultsCap,
        maxChars: w.maxChars,
        maxFetchChars: w.maxFetchChars,
        cacheTtlMs: w.cacheTtlMs,
        fetchPolicy: w.fetchPolicy,
        maxUrlLength: w.maxUrlLength,
      });
    });
  r.tools.set('web_search', (_o, ctx) => web(ctx).web_search);
  r.tools.set('web_fetch', (_o, ctx) => {
    const tool = web(ctx).web_fetch;
    if (!tool) throw new Error(`web_fetch is not available (web provider "${ctx.config.web?.provider}", fetchPolicy "${ctx.config.web?.fetchPolicy ?? 'search-results'}")`);
    return tool;
  });
  const signals = (ctx: FactoryContext) =>
    ctx.once('signals', () => {
      const { sources, ...s } = interpolate(ctx.config.signals ?? {}, ctx.env, '$.signals');
      return signalTools({ ...s, ...(sources && { sources }), env: ctx.env });
    });
  for (const name of ['search_discussions', 'search_projects', 'search_questions', 'search_papers']) {
    r.tools.set(name, (_o, ctx) => {
      const tool = signals(ctx)[name];
      if (!tool) throw new Error(`${name} is not available (not in signals.sources)`);
      return tool;
    });
  }
  return r;
}
