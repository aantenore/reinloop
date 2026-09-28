import { resolve } from 'node:path';
import { type CacheStore, fileCache, memoryCache } from './cache.ts';
import { summarizeCompaction, windowCompaction } from './compaction.ts';
import type { Env, HarnessConfig } from './config/load.ts';
import { BUILTIN_PATTERNS, type PatternDefinition } from './patterns.ts';
import { fileNotes, memoryNotes, memoryTools } from './tools/memory.ts';
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
  return r;
}
