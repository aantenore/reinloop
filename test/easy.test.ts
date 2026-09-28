import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  agent, collectSink, createRegistry, definePattern, loadProject, mockProvider, paramsSchema, parseAgentFile, parseFrontmatter, resolveModel,
  team, tool, withResponseCache, memoryCache, workspaceTools, type Agent, type Team, type ToolContext,
} from '../src/index.ts';

const m = (script: Parameters<typeof mockProvider>[0], name?: string) => ({ provider: mockProvider(script, { name }), model: 'mock' });
const ctx = { signal: new AbortController().signal, agent: 'a' } as ToolContext;

describe('easy api', () => {
  it('builds a runnable agent with shorthand tools and sessions', async () => {
    const weather = tool('weather', 'Weather', { city: 'string: City name', days: 'integer?' }, ({ city }) => ({ city, sky: 'sunny' }));
    assert.deepEqual(weather.schema, {
      type: 'object',
      properties: { city: { type: 'string', description: 'City name' }, days: { type: 'integer' } },
      required: ['city'],
      additionalProperties: false,
    });
    const a = agent({ model: m([{ toolCalls: [{ name: 'weather', args: { city: 'Rome' } }] }, { text: 'sunny in Rome' }, { text: 'again' }]), tools: [weather] });
    const res = await a.run('weather?');
    assert.equal(res.output, 'sunny in Rome');
    assert.match(JSON.stringify(res.messages), /\\"sky\\":\\"sunny\\"/);
    const chat = a.session();
    await chat.send('one');
    assert.equal(chat.runId !== undefined, true);
  });

  it('turns agents into delegated tools and structured output into data', async () => {
    const helper = agent({ name: 'helper', description: 'Helps', model: m([{ text: '42' }]) });
    const boss = agent({
      name: 'boss',
      model: m([{ toolCalls: [{ name: 'helper', args: { task: 'compute' } }] }, { text: '{"answer": 42}' }]),
      tools: [helper],
      output: { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'] },
    });
    assert.deepEqual(boss.tools.map((t) => t.name), ['helper']);
    assert.deepEqual((await boss.run('go')).data, { answer: 42 });
  });

  it('parses enum and array shorthands and rejects typos', () => {
    assert.deepEqual(paramsSchema({ unit: ['c', 'f'], tags: 'string[]?' }).properties, { unit: { enum: ['c', 'f'] }, tags: { type: 'array', items: { type: 'string' } } });
    assert.throws(() => paramsSchema({ x: 'strng' }), /invalid parameter "x"/);
  });

  it('resolves provider/model strings and aliases', () => {
    const ref = resolveModel('openai/gpt-5-mini', { OPENAI_API_KEY: 'k' });
    assert.equal(ref.provider.name, 'openai');
    assert.equal(ref.model, 'gpt-5-mini');
    assert.equal(resolveModel('openrouter/anthropic/claude-x', {}).model, 'anthropic/claude-x');
    assert.equal(resolveModel('sonnet', {}).provider.name, 'anthropic');
    assert.equal(resolveModel(undefined, {}).provider.name, 'ollama');
    assert.throws(() => resolveModel('nope/x', {}), /unknown provider "nope"/);
  });
});

describe('patterns', () => {
  it('chain passes each output to the next step', async () => {
    const a = agent({ name: 'a', model: m([{ text: 'outline' }]) });
    const b = agent({ name: 'b', model: m([{ text: 'draft' }]) });
    const res = await team('pipe', 'chain', { steps: [a, b] }).run('write');
    assert.equal(res.output, 'draft');
    assert.match(JSON.stringify((b.model.provider as ReturnType<typeof mockProvider>).requests[0]!.messages), /outline/);
  });

  it('parallel fans out and aggregates, with duplicate workers labelled', async () => {
    const w1 = agent({ name: 'solver', model: m([{ text: 'A' }]) });
    const w2 = agent({ name: 'solver', model: m([{ text: 'B' }]) });
    const agg = agent({ name: 'judge', model: m([{ text: 'A wins' }]) });
    const res = await team('vote', 'parallel', { workers: [w1, w2], aggregator: agg }).run('pick');
    assert.equal(res.output, 'A wins');
    const seen = JSON.stringify((agg.model.provider as ReturnType<typeof mockProvider>).requests[0]!.messages);
    assert.match(seen, /## solver\\n/);
    assert.match(seen, /## solver#2/);
    const plain = await team('fan', 'parallel', { workers: [agent({ name: 'p', model: m([{ text: 'P' }]) })] }).run('go');
    assert.deepEqual(plain.data, { results: { p: 'P' } });
  });

  it('router picks a route by structured choice', async () => {
    const billing = agent({ name: 'billing', description: 'Invoices', model: m([{ text: 'billing handled' }]) });
    const tech = agent({ name: 'tech', description: 'Bugs', model: m([{ text: 'tech handled' }]) });
    const router = agent({ name: 'router', model: m([{ text: '{"route":"tech","reason":"bug"}' }]) });
    const res = await team('desk', 'router', { router, routes: [billing, tech] }).run('app crashes');
    assert.equal(res.output, 'tech handled');
  });

  it('evaluator loops until pass and keeps the generator session', async () => {
    const gen = agent({ name: 'gen', model: m([{ text: 'v1' }, { text: 'v2' }]) });
    const critic = agent({ name: 'critic', model: m([{ text: '{"pass":false,"feedback":"more"}' }, { text: '{"pass":true,"feedback":"ok"}' }]) });
    const res = await team('loop', 'evaluator', { generator: gen, evaluator: critic }, { maxRounds: 3 }).run('write');
    assert.equal(res.output, 'v2');
    assert.deepEqual(res.data, { rounds: 2, passed: true, feedback: 'ok' });
    assert.equal((gen.model.provider as ReturnType<typeof mockProvider>).requests[1]!.messages.length, 3, 'revision continues the same conversation');
    assert.equal(res.turns, 4);
  });

  it('orchestrator delegates to workers as tools and teams nest', async () => {
    const worker = agent({ name: 'worker', description: 'Does work', model: m([{ text: 'done part' }]) });
    const lead = agent({ name: 'lead', model: m([{ toolCalls: [{ name: 'worker', args: { task: 'part' } }] }, { text: 'all done' }]) });
    const inner = team('crew', 'orchestrator', { orchestrator: lead, workers: [worker] }, {}, { description: 'Crew' });
    const sink = collectSink();
    const outer = team('outer', 'chain', { steps: [inner] });
    const res = await outer.run('go', { sinks: [sink] });
    assert.equal(res.output, 'all done');
    assert.ok(sink.events.filter((e) => e.type === 'run_start').length >= 4);
  });

  it('validates roles and supports custom patterns with custom roles', async () => {
    const a = agent({ name: 'a', model: m([{ text: 'x' }]) });
    assert.throws(() => team('bad', 'evaluator', { generator: a }), /role "evaluator" is required/);
    assert.throws(() => team('bad', 'chain', { steps: [a], extra: a }), /unknown role "extra"/);
    const debate = definePattern({
      description: 'Two sides argue, a judge decides',
      roles: { pro: { description: 'For' }, con: { description: 'Against' }, judge: { description: 'Decides' } },
      build: ({ pro, con, judge }) => async (_input, ctx) => {
        const [p, c] = await Promise.all([ctx.call(pro, ctx.task), ctx.call(con, ctx.task)]);
        const verdict = await ctx.call(judge, `PRO: ${p.output}\nCON: ${c.output}`);
        return { output: verdict.output };
      },
    });
    const res = await team('d', debate, {
      pro: agent({ name: 'pro', model: m([{ text: 'yes' }]) }),
      con: agent({ name: 'con', model: m([{ text: 'no' }]) }),
      judge: agent({ name: 'judge', model: m([{ text: 'yes wins' }]) }),
    }).run('should we?');
    assert.equal(res.output, 'yes wins');
    assert.ok(createRegistry().patterns.has('orchestrator'));
  });
});

describe('agent files', () => {
  it('parses frontmatter subset', () => {
    const { data, body } = parseFrontmatter(`---
name: "x"
tools: [read_file, 'b c']   # comment
budget: { maxTurns: 5, maxCostUsd: 0.5 }
model: ollama/qwen3:8b
roles:
  steps:
    - a
    - b
nested:
  - key: v
    other: 2
text: |
  line 1
  line 2
flag: true
---
Body`);
    assert.deepEqual(data, {
      name: 'x', tools: ['read_file', 'b c'], budget: { maxTurns: 5, maxCostUsd: 0.5 }, model: 'ollama/qwen3:8b',
      roles: { steps: ['a', 'b'] }, nested: [{ key: 'v', other: 2 }], text: 'line 1\nline 2', flag: true,
    });
    assert.equal(body, 'Body');
  });

  it('maps common tool aliases and detects teams', () => {
    const a = parseAgentFile('---\ndescription: d\ntools: Read, Grep, Bash\ncolor: red\n---\nDo it.', 'rev');
    assert.deepEqual(a, { kind: 'agent', name: 'rev', config: { description: 'd', tools: ['read_file', 'search_files', 'shell'], instructions: 'Do it.' } });
    const t = parseAgentFile('---\npattern: evaluator\nroles: { generator: a, evaluator: b }\n---\nWrites and reviews.', 'loop');
    assert.deepEqual(t, { kind: 'team', name: 'loop', config: { pattern: 'evaluator', roles: { generator: 'a', evaluator: 'b' }, description: 'Writes and reviews.' } });
    assert.throws(() => parseAgentFile('---\ntool: x\n---\n', 'x'), /unknown field\(s\) tool/);
  });

  it('loads a zero-config project from agents/*.md with teams, cache and memory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reinloop-proj-'));
    await mkdir(join(dir, 'agents'));
    await writeFile(join(dir, 'agents', 'writer.md'), '---\ndescription: Writes\nmodel: mock/echo\ntools: [remember]\n---\nWrite well.');
    await writeFile(join(dir, 'agents', 'critic.md'), '---\nmodel: mock/echo\n---\nJudge.');
    await writeFile(join(dir, 'agents', 'pipeline.md'), '---\npattern: chain\nroles: { steps: [writer, critic] }\n---\nWrite then critique.');
    const rt = await loadProject({ cwd: dir, env: {} });
    try {
      assert.deepEqual(rt.names().sort(), ['critic', 'pipeline', 'writer']);
      const t = (await rt.agent('pipeline')) as Team;
      assert.equal(t.kind, 'team');
      assert.equal(t.description, 'Write then critique.');
      const res = await rt.run('pipeline', 'hello');
      assert.equal(res.status, 'completed');
      assert.match(res.output, /^echo: hello/);
      const writer = (await rt.agent('writer')) as Agent;
      await writer.tools[0]!.run({ text: 'likes tea' }, { ...ctx, agent: 'writer' });
      assert.match(await readFile(join(dir, '.reinloop', 'memory', 'default.jsonl'), 'utf8'), /likes tea/);
    } finally {
      await rt.close();
    }
    const empty = await mkdtemp(join(tmpdir(), 'reinloop-empty-'));
    const def = await loadProject({ cwd: empty, env: { REINLOOP_MODEL: 'mock/echo' } });
    assert.deepEqual(def.names(), ['assistant']);
    assert.equal((await def.run(undefined, 'hi')).output, 'echo: hi');
  });
});

describe('cache, memory and workspace tools', () => {
  it('replays identical requests from the response cache at zero cost', async () => {
    const provider = mockProvider([{ text: 'fresh', usage: { inputTokens: 10, outputTokens: 5 } }]);
    const cached = withResponseCache(provider, memoryCache());
    const a = agent({ model: { provider: cached, model: 'x', pricing: { inputPerMTok: 1000, outputPerMTok: 1000 } } });
    const first = await a.run('same');
    const second = await a.run('same');
    assert.equal(provider.requests.length, 1);
    assert.equal(second.output, 'fresh');
    assert.ok(first.costUsd > 0);
    assert.equal(second.costUsd, 0);
  });

  it('edits, finds and searches files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reinloop-ws2-'));
    await mkdir(join(root, 'src', 'deep'), { recursive: true });
    await mkdir(join(root, 'node_modules', 'x'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'const a = 1;\nconst b = 1;\n');
    await writeFile(join(root, 'src', 'deep', 'b.ts'), 'export const TODO = true;\n');
    await writeFile(join(root, 'node_modules', 'x', 'c.ts'), 'TODO');
    const t = workspaceTools({ root });
    assert.equal((await t.edit_file!.run({ path: 'src/a.ts', old: '= 1', new: '= 2' }, ctx) as { isError: boolean }).isError, true);
    await t.edit_file!.run({ path: 'src/a.ts', old: 'const a = 1', new: 'const a = 3' }, ctx);
    assert.match(await readFile(join(root, 'src', 'a.ts'), 'utf8'), /const a = 3/);
    assert.equal(await t.find_files!.run({ pattern: 'src/**/*.ts' }, ctx), 'src/a.ts\nsrc/deep/b.ts');
    assert.equal(await t.search_files!.run({ pattern: 'TODO' }, ctx), 'src/deep/b.ts:1: export const TODO = true;');
  });
});
