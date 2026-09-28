// Live check of the integration catalogue: adds each entry with `addIntegration`, connects through the real
// upstream MCP server (downloaded by npx/uvx on first use) and calls real tools. Not part of CI.
// Usage: node scripts/live/integrations.ts [name ...]
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { addIntegration, loadProject, type Agent, type Tool, type ToolContext } from '../../src/index.ts';

type Call = [tool: string, args: Record<string, unknown>];
interface Check { patch?: (cfg: any, dir: string) => void; calls: (dir: string) => Call[]; expect?: RegExp }

const repo = resolve(new URL('../..', import.meta.url).pathname);

const CHECKS: Record<string, Check> = {
  chroma: {
    calls: () => [
      ['chroma__chroma_create_collection', { collection_name: 'docs' }],
      ['chroma__chroma_add_documents', { collection_name: 'docs', documents: ['reinloop runs agents defined as Markdown files', 'Bananas are yellow'], ids: ['a', 'b'] }],
      ['chroma__chroma_query_documents', { collection_name: 'docs', query_texts: ['how are agents defined?'], n_results: 1 }],
    ],
    expect: /Markdown files/,
  },
  qdrant: {
    patch: (cfg, dir) => (cfg.mcpServers.qdrant.env = { QDRANT_LOCAL_PATH: join(dir, 'qdrant'), COLLECTION_NAME: 'docs' }),
    calls: () => [
      ['qdrant__qdrant-store', { information: 'reinloop runs agents defined as Markdown files' }],
      ['qdrant__qdrant-store', { information: 'Bananas are yellow' }],
      ['qdrant__qdrant-find', { query: 'how are agents defined?' }],
    ],
    expect: /Markdown files/,
  },
  'memory-graph': {
    patch: (cfg, dir) => (cfg.mcpServers['memory-graph'].env = { MEMORY_FILE_PATH: join(dir, 'graph.json') }),
    calls: () => [
      ['memory-graph__create_entities', { entities: [{ name: 'reinloop', entityType: 'project', observations: ['agents are Markdown files'] }] }],
      ['memory-graph__read_graph', {}],
    ],
    expect: /agents are Markdown files/,
  },
  fetch: { calls: () => [['fetch__fetch', { url: 'https://example.com', max_length: 2000 }]], expect: /documentation examples/ },
  git: {
    patch: (cfg) => (cfg.mcpServers.git.args = ['mcp-server-git', '--repository', repo]),
    calls: () => [['git__git_log', { repo_path: repo, max_count: 1 }]],
    expect: /Antonio Antenore/,
  },
  playwright: { calls: () => [] },
};

const ctx = { signal: AbortSignal.timeout(300_000), agent: 'live', runId: 'live', state: {} as never, emit: () => {}, inherit: {} } as ToolContext;
const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(CHECKS);
const rows: string[] = [];

for (const name of names) {
  const check = CHECKS[name]!;
  const dir = mkdtempSync(join(tmpdir(), `reinloop-live-${name}-`));
  const cfgPath = join(dir, 'reinloop.json');
  const t0 = Date.now();
  let status = 'ok';
  let detail = '';
  let tools: Tool[] = [];
  try {
    await addIntegration(name, { configPath: cfgPath });
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    check.patch?.(cfg, dir);
    cfg.agents = { probe: { model: 'mock/echo', tools: [`${name}__*`] } };
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    mkdirSync(join(dir, 'agents'), { recursive: true });
    const rt = await loadProject({ cwd: dir, env: process.env });
    try {
      tools = ((await rt.agent('probe')) as Agent).tools;
      let last = '';
      for (const [toolName, args] of check.calls(dir)) {
        const tool = tools.find((t) => t.name === toolName);
        if (!tool) throw new Error(`tool ${toolName} not found; have ${tools.map((t) => t.name).join(', ')}`);
        const out = await tool.run(args, ctx);
        last = typeof out === 'string' ? out : out.content;
        if (typeof out !== 'string' && out.isError) throw new Error(`${toolName} returned an error: ${last.slice(0, 300)}`);
      }
      if (check.expect && !check.expect.test(last)) throw new Error(`unexpected result: ${last.slice(0, 300)}`);
      detail = last ? last.replace(/\s+/g, ' ').slice(0, 90) : 'connected, tools listed';
    } finally {
      await rt.close();
    }
  } catch (err) {
    status = 'FAIL';
    detail = (err as Error).message.replace(/\s+/g, ' ').slice(0, 300);
  }
  const line = `| ${name} | ${status} | ${tools.length} | ${Math.round((Date.now() - t0) / 1000)}s | ${detail.replace(/\|/g, '/')} |`;
  rows.push(line);
  console.log(line);
}

let versions = '';
try {
  versions = `uv ${execFileSync('uv', ['--version']).toString().trim()}, node ${process.version}`;
} catch {
  versions = `node ${process.version}`;
}
console.log(`\n| Integration | Status | Tools | Time | Result |\n|---|---|---|---|---|\n${rows.join('\n')}\n\n${versions}`);
