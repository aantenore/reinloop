import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import type { ComponentConfig, HarnessConfig } from './config/load.ts';
import type { McpServerConfig } from './mcp/client.ts';

/**
 * Catalogue of existing technologies wired through open standards (MCP, OpenAI-compatible HTTP, OTLP).
 * Nothing here is reimplemented: each entry is only the configuration that connects a maintained project.
 */
export interface Integration {
  kind: 'knowledge' | 'memory' | 'web' | 'code' | 'browser' | 'gateway' | 'observability' | 'eval';
  description: string;
  /** Upstream project that does the work. */
  source: string;
  mcp?: McpServerConfig;
  provider?: ComponentConfig;
  sink?: ComponentConfig;
  /** Environment variables to set, with a hint. */
  env?: Record<string, string>;
  /** Suggested value for an agent's `tools`. */
  tools?: string;
  next: string;
}

export const INTEGRATIONS: Record<string, Integration> = {
  qdrant: {
    kind: 'knowledge',
    description: 'Semantic search over a Qdrant collection (RAG)',
    source: 'https://github.com/qdrant/mcp-server-qdrant',
    // Pinned interpreter: some native dependencies ship no wheels for the newest Python yet.
    mcp: { command: 'uvx', args: ['--python', '3.12', 'mcp-server-qdrant'], env: { QDRANT_URL: '${env:QDRANT_URL:-http://localhost:6333}', COLLECTION_NAME: '${env:QDRANT_COLLECTION:-docs}' } },
    env: { QDRANT_URL: 'Qdrant endpoint', QDRANT_COLLECTION: 'collection to search' },
    tools: 'qdrant__*',
    next: 'Load documents with your ingestion pipeline (Qdrant clients, LlamaIndex, Unstructured) or the server\'s store tool for small sets.',
  },
  chroma: {
    kind: 'knowledge',
    description: 'Local persistent Chroma collections: add, query, filter (RAG without a server)',
    source: 'https://github.com/chroma-core/chroma-mcp',
    mcp: { command: 'uvx', args: ['--python', '3.12', 'chroma-mcp', '--client-type', 'persistent', '--data-dir', '.reinloop/chroma'] },
    tools: 'chroma__*',
    next: 'Small corpora can be added by an agent with the add-documents tool; use Chroma loaders for bulk ingestion.',
  },
  'memory-graph': {
    kind: 'memory',
    description: 'Knowledge-graph memory (entities, relations, observations) across sessions',
    source: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
    mcp: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'], env: { MEMORY_FILE_PATH: '.reinloop/memory-graph.json' } },
    tools: 'memory-graph__*',
    next: 'For simple notes the built-in remember/recall tools need no server.',
  },
  fetch: {
    kind: 'web',
    description: 'Fetch web pages as Markdown',
    source: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
    mcp: { command: 'uvx', args: ['mcp-server-fetch'] },
    tools: 'fetch__*',
    next: 'Fetched content is untrusted: keep write/exec tools behind "ask" for agents that browse.',
  },
  git: {
    kind: 'code',
    description: 'Read and operate on a local git repository',
    source: 'https://github.com/modelcontextprotocol/servers/tree/main/src/git',
    mcp: { command: 'uvx', args: ['mcp-server-git', '--repository', '.'] },
    tools: 'git__*',
    next: 'Destructive git tools are annotated and will ask for approval.',
  },
  github: {
    kind: 'code',
    description: 'Issues, pull requests, code search on GitHub (remote server)',
    source: 'https://github.com/github/github-mcp-server',
    mcp: { url: 'https://api.githubcopilot.com/mcp/', headers: { authorization: 'Bearer ${env:GITHUB_TOKEN}' } },
    env: { GITHUB_TOKEN: 'personal access token with the scopes you want the agent to have' },
    tools: 'github__*',
    next: 'Prefer include/exclude globs to expose only the tools an agent needs.',
  },
  playwright: {
    kind: 'browser',
    description: 'Drive a real browser through accessibility snapshots',
    source: 'https://github.com/microsoft/playwright-mcp',
    mcp: { command: 'npx', args: ['@playwright/mcp@latest'] },
    tools: 'playwright__*',
    next: 'Browsing agents read untrusted pages: keep them away from secrets and write tools.',
  },
  litellm: {
    kind: 'gateway',
    description: 'LiteLLM proxy in front of 100+ providers: fallbacks, budgets, guardrails, caching',
    source: 'https://docs.litellm.ai/docs/simple_proxy',
    provider: { type: 'openai-compatible', baseUrl: '${env:LITELLM_URL:-http://localhost:4000}', apiKey: '${env:LITELLM_API_KEY:-}', stream: true },
    env: { LITELLM_URL: 'proxy URL', LITELLM_API_KEY: 'virtual key' },
    next: 'Use models as "litellm/<model-name>". Keep semantic caching off for agent traffic (exact-match only).',
  },
  otel: {
    kind: 'observability',
    description: 'Traces to any OpenTelemetry collector (Jaeger, Tempo, Honeycomb, Datadog, ...)',
    source: 'https://opentelemetry.io/docs/specs/semconv/gen-ai/',
    sink: { type: 'otlp', endpoint: '${env:OTEL_EXPORTER_OTLP_ENDPOINT:-http://localhost:4318}' },
    next: 'OTLP/HTTP JSON; put an OpenTelemetry Collector in front of backends that only accept protobuf.',
  },
  langfuse: {
    kind: 'observability',
    description: 'Langfuse tracing through its OpenTelemetry endpoint',
    source: 'https://langfuse.com/integrations/native/opentelemetry',
    sink: {
      type: 'otlp',
      endpoint: '${env:LANGFUSE_HOST:-https://cloud.langfuse.com}/api/public/otel',
      headers: { authorization: 'Basic ${env:LANGFUSE_AUTH}' },
    },
    env: { LANGFUSE_AUTH: 'base64 of "<public key>:<secret key>"', LANGFUSE_HOST: 'self-hosted URL (optional)' },
    next: 'If your Langfuse version rejects OTLP JSON, route through an OpenTelemetry Collector.',
  },
  promptfoo: {
    kind: 'eval',
    description: 'Regression tests and evals for agents via promptfoo\'s HTTP provider against `reinloop serve`',
    source: 'https://www.promptfoo.dev/docs/providers/http/',
    next: 'Run `reinloop serve` in one terminal, then `npx promptfoo eval` with the generated promptfooconfig.yaml.',
  },
};

const PROMPTFOO = (agent: string) => `# Evaluates the "${agent}" agent through reinloop's HTTP API (start it with: reinloop serve)
description: ${agent} regression suite
providers:
  - id: http
    config:
      url: http://127.0.0.1:7878/v1/agents/${agent}/runs
      method: POST
      headers:
        content-type: application/json
      body:
        input: '{{prompt}}'
      transformResponse: json.output
prompts:
  - '{{task}}'
tests:
  - vars:
      task: Replace with a real task for ${agent}
    assert:
      - type: contains
        value: replace-with-expected-text
      - type: llm-rubric
        value: Replace with what a good answer must do
`;

export interface AddResult { changed: string; next: string[] }

/** Adds an integration to reinloop.json (created if missing). Existing entries are never overwritten. */
export async function addIntegration(name: string, opts: { configPath: string; agent?: string }): Promise<AddResult> {
  const item = INTEGRATIONS[name];
  if (!item) throw new Error(`unknown integration "${name}" (available: ${Object.keys(INTEGRATIONS).join(', ')})`);
  const next = [item.next, ...Object.entries(item.env ?? {}).map(([k, hint]) => `set ${k}: ${hint}`)];

  if (name === 'promptfoo') {
    const file = 'promptfooconfig.yaml';
    if (existsSync(file)) throw new Error(`${file} already exists`);
    await writeFile(file, PROMPTFOO(opts.agent ?? 'assistant'));
    return { changed: file, next };
  }

  const config: HarnessConfig = existsSync(opts.configPath)
    ? JSON.parse(await readFile(opts.configPath, 'utf8'))
    : { $schema: './node_modules/reinloop/schema/reinloop.schema.json' };
  if (item.mcp) {
    config.mcpServers ??= {};
    if (config.mcpServers[name]) throw new Error(`mcpServers.${name} already exists in ${opts.configPath}`);
    config.mcpServers[name] = item.mcp;
    next.unshift(`give an agent the tools: add "${item.tools}" to its tools list`);
  }
  if (item.provider) {
    config.providers ??= {};
    if (config.providers[name]) throw new Error(`providers.${name} already exists in ${opts.configPath}`);
    config.providers[name] = item.provider;
  }
  if (item.sink) {
    config.sinks = [...(config.sinks ?? []), item.sink];
  }
  await writeFile(opts.configPath, `${JSON.stringify(config, null, 2)}\n`);
  return { changed: opts.configPath, next };
}
