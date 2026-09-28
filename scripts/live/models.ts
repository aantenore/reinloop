// Live model matrix against local Ollama models. Not part of CI. Needs Ollama running and, for the RAG scenario,
// `uvx` (downloads chroma-mcp on first use).
// Usage: node scripts/live/models.ts [model ...]   e.g. node scripts/live/models.ts gemma4:12b qwen3.5:9b
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  agent, design, loadProject, mcpTools, missingCredentials, resolveModel, team, workspaceTools, type RunResult, type Tool,
} from '../../src/index.ts';

// Usage: node scripts/live/models.ts [--only rag,create] [model ...]
const args = process.argv.slice(2);
const onlyAt = args.indexOf('--only');
const only = onlyAt >= 0 ? new Set(args.splice(onlyAt, 2)[1]!.split(',')) : undefined;
const models = args.length ? args : ['gemma4:12b', 'gemma4-quick:12b', 'ornith:9b', 'lfm2.5:8b', 'qwen3.5:9b', 'qwen3:4b'];
const TIMEOUT = 8 * 60_000;
const repo = resolve(new URL('../..', import.meta.url).pathname);
const out = mkdtempSync(join(tmpdir(), 'reinloop-matrix-'));

interface Row { model: string; scenario: string; pass: boolean; seconds: number; turns: number; note: string }
const rows: Row[] = [];

async function timed(model: string, scenario: string, fn: (signal: AbortSignal) => Promise<{ pass: boolean; turns: number; note: string }>) {
  if (only && !only.has(scenario)) return;
  const t0 = Date.now();
  let row: Row;
  try {
    const r = await fn(AbortSignal.timeout(TIMEOUT));
    row = { model, scenario, ...r, seconds: Math.round((Date.now() - t0) / 1000) };
  } catch (err) {
    row = { model, scenario, pass: false, turns: 0, note: (err as Error).message.slice(0, 160), seconds: Math.round((Date.now() - t0) / 1000) };
  }
  rows.push(row);
  console.log(JSON.stringify(row));
  writeFileSync(join(out, 'results.json'), JSON.stringify(rows, null, 2));
}

const brief = (r: RunResult) => `${r.status}${r.reason ? ` (${r.reason})` : ''}: ${r.output.replace(/\s+/g, ' ').slice(0, 80)}`;

// Shared fixtures: a workspace with a fact to find, and a Chroma collection with this project's docs.
const ws = mkdtempSync(join(tmpdir(), 'reinloop-ws-'));
mkdirSync(join(ws, 'notes'));
writeFileSync(join(ws, 'notes', 'project.md'), '# Project\n\nThe project codename is BLUE HERON.\n');
const chroma = await mcpTools('kb', { command: 'uvx', args: ['--python', '3.12', 'chroma-mcp', '--client-type', 'persistent', '--data-dir', join(out, 'chroma')], readOnly: ['chroma_query_*'] });
const add = chroma.tools.find((t) => t.name === 'kb__chroma_add_documents')!;
const ctx = { signal: AbortSignal.timeout(600_000), agent: 'setup', runId: 'setup', state: {} as never, emit: () => {}, inherit: {} } as never;
await chroma.tools.find((t) => t.name === 'kb__chroma_create_collection')!.run({ collection_name: 'docs' }, ctx);
const chunks = ['README.md', ...readdirSync(join(repo, 'docs')).map((f) => `docs/${f}`)].flatMap((f) =>
  readFileSync(join(repo, f), 'utf8').split(/\n(?=## )/).map((text, i) => ({ id: `${f}#${i}`, text: text.slice(0, 4000) })),
);
await add.run({ collection_name: 'docs', documents: chunks.map((c) => c.text), ids: chunks.map((c) => c.id) }, ctx);
const query: Tool = chroma.tools.find((t) => t.name === 'kb__chroma_query_documents')!;
console.log(`indexed ${chunks.length} chunks; results in ${out}`);

for (const name of models) {
  const model = resolveModel(`ollama/${name}`);

  await timed(name, 'tools', async (signal) => {
    const t = workspaceTools({ root: ws });
    const r = await agent({ model, tools: [t.find_files!, t.read_file!, t.list_dir!], instructions: 'Answer from the files. Be brief.', budget: { maxTurns: 12 } })
      .run('What is the project codename?', { signal });
    return { pass: /BLUE HERON/i.test(r.output), turns: r.turns, note: brief(r) };
  });

  await timed(name, 'structured', async (signal) => {
    const r = await agent({ model, output: { type: 'object', properties: { answer: { type: 'integer' } }, required: ['answer'] }, budget: { maxTurns: 6 } })
      .run('What is 17 * 3?', { signal });
    return { pass: (r.data as { answer?: number } | undefined)?.answer === 51, turns: r.turns, note: brief(r) };
  });

  await timed(name, 'rag', async (signal) => {
    const r = await agent({
      model,
      tools: [query],
      instructions: 'Answer only from the knowledge base (collection "docs"). Search it first. Be brief.',
      budget: { maxTurns: 10 },
    }).run('On which port does `reinloop serve` listen by default?', { signal });
    return { pass: /7878/.test(r.output), turns: r.turns, note: brief(r) };
  });

  await timed(name, 'team', async (signal) => {
    const writer = agent({ name: 'writer', model, instructions: 'Write one concrete sentence of product copy for the given product.' });
    const critic = agent({ name: 'critic', model, instructions: 'Judge whether the copy is concrete and specific.' });
    const r = await team('copy', 'evaluator', { generator: writer, evaluator: critic }, { maxRounds: 2 }).run('A zero-dependency agent harness', { signal });
    const ok = (r.status === 'completed' || r.reason === 'evaluator:maxRounds') && r.output.length > 0;
    return { pass: ok, turns: r.turns, note: `${brief(r)} ${JSON.stringify(r.data ?? {})}`.slice(0, 160) };
  });

  await timed(name, 'create', async (signal) => {
    const dir = mkdtempSync(join(tmpdir(), 'reinloop-create-'));
    const { result: r } = await design(
      'A team that writes a short LinkedIn post on a topic: an author drafts and an editor critiques until it is convincing and concrete.',
      { cwd: dir, model, onHandle: async (h) => signal.addEventListener('abort', () => h.abort(signal.reason), { once: true }) },
    );
    let valid = 'invalid';
    try {
      const rt = await loadProject({ cwd: dir, env: { REINLOOP_MODEL: `ollama/${name}` } });
      for (const n of rt.names()) await rt.agent(n);
      const hasTeam = Object.keys(rt.config.teams ?? {}).length > 0;
      valid = missingCredentials(rt.config).length ? 'pinned model without key' : hasTeam ? 'valid with team' : 'valid, no team';
      await rt.close();
    } catch (err) {
      valid = `invalid: ${(err as Error).message.slice(0, 80)}`;
    }
    return { pass: valid === 'valid with team', turns: r.turns, note: `${r.status}; ${valid}` };
  });
}

await chroma.client.close();
const table = ['| Model | Scenario | Pass | Turns | Time | Note |', '|---|---|---|---|---|---|', ...rows.map((r) => `| ${r.model} | ${r.scenario} | ${r.pass ? 'yes' : 'no'} | ${r.turns} | ${r.seconds}s | ${r.note.replace(/\|/g, '/')} |`)];
writeFileSync(join(out, 'results.md'), `${table.join('\n')}\n`);
console.log(`\n${table.join('\n')}\n\nresults: ${out}`);
