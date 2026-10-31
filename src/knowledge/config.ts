import { resolve } from 'node:path';
import { McpClient, type McpServerConfig } from '../mcp/client.ts';
import type { FactoryContext } from '../registry.ts';
import type { KnowledgeSource } from '../types.ts';
import { interpolate } from '../config/load.ts';
import { httpKnowledge, mcpKnowledge, wikiKnowledge } from './adapters.ts';
import type { KnowledgeMiddlewareOptions } from './middleware.ts';

/** One entry of `knowledge.sources`; the key is the source name used in citations. */
export interface KnowledgeSourceConfig {
  type: 'mcp' | 'http' | 'wiki';
  /** `mcp`: name of an entry in `mcpServers` to connect to (a separate connection), or the inline fields below. */
  server?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** `mcp`: server URL (streamable HTTP). `http`: endpoint receiving `POST { query, k, filter }`. */
  url?: string;
  headers?: Record<string, string>;
  /** `mcp`: retrieval tool, e.g. `qdrant-find`. */
  tool?: string;
  /** `mcp`: argument that receives the query (default `query`). */
  queryArg?: string;
  /** `mcp`: constant extra tool arguments. */
  toolArgs?: Record<string, unknown>;
  timeoutMs?: number;
  /** `http`, `mcp`: response text kept in a source error (default 300). */
  errorBodyChars?: number;
  /** `wiki`: folder of Markdown files, relative to the config file. */
  dir?: string;
  maxPassageChars?: number;
}

// Runtime wiring: turns `config.knowledge` into sources. The adapters themselves do not know about the runtime.

/** Settings of the `knowledge` middleware (auto-retrieval) and the `search_knowledge` tool. */
export interface KnowledgeConfig {
  sources?: Record<string, KnowledgeSourceConfig>;
  k?: number;
  maxChars?: number;
  mode?: 'first-turn' | 'every-turn';
  timeoutMs?: number;
  /** `search_knowledge` result size (default: `maxChars` when set, else 8000). */
  toolMaxChars?: number;
  maxK?: number;
  maxQueryChars?: number;
  maxTrackedRuns?: number;
}

export interface BuiltKnowledge extends Omit<KnowledgeMiddlewareOptions, 'sources'> { sources: KnowledgeSource[]; toolMaxChars?: number; maxK?: number }

function build(name: string, s: KnowledgeSourceConfig, ctx: FactoryContext, path: string): KnowledgeSource {
  switch (s.type) {
    case 'wiki':
      if (!s.dir) throw new Error(`${path}.dir is required for type "wiki"`);
      return wikiKnowledge({ name, dir: resolve(ctx.baseDir, s.dir), maxPassageChars: s.maxPassageChars });
    case 'http':
      if (!s.url) throw new Error(`${path}.url is required for type "http"`);
      return httpKnowledge({ name, url: s.url, headers: s.headers, timeoutMs: s.timeoutMs, errorBodyChars: s.errorBodyChars, minSecretChars: ctx.limits?.minSecretChars });
    case 'mcp': {
      if (!s.tool) throw new Error(`${path}.tool is required for type "mcp"`);
      let server: McpServerConfig;
      if (s.server) {
        const named = ctx.config.mcpServers?.[s.server];
        if (!named) throw new Error(`${path}.server: unknown MCP server "${s.server}"`);
        server = interpolate(named, ctx.env, `$.mcpServers.${s.server}`);
      } else {
        const { command, args, env, cwd, url, headers, timeoutMs } = s;
        server = { command, args, env, cwd, url, headers, timeoutMs };
      }
      const queryArg = s.queryArg ?? 'query';
      const minSecretChars = ctx.limits?.minSecretChars;
      const source = mcpKnowledge({
        name, connect: () => McpClient.connect(name, server, { minSecretChars }), tool: s.tool, args: (q) => ({ ...s.toolArgs, [queryArg]: q.query }), errorBodyChars: s.errorBodyChars,
      });
      ctx.onClose(() => source.close());
      return source;
    }
    default:
      throw new Error(`${path}.type: unknown knowledge source type "${(s as { type: string }).type}" (mcp, http, wiki)`);
  }
}

/** Builds the sources and settings from `config.knowledge` (environment placeholders resolved). Throws when none are configured. */
export function knowledgeFromConfig(ctx: FactoryContext): BuiltKnowledge {
  const { sources, ...rest } = interpolate(ctx.config.knowledge ?? {}, ctx.env, '$.knowledge') as KnowledgeConfig;
  const entries = Object.entries(sources ?? {});
  if (!entries.length) throw new Error('knowledge is not configured (add sources under "knowledge.sources")');
  return { ...rest, sources: entries.map(([name, s]) => build(name, s, ctx, `$.knowledge.sources.${name}`)) };
}
