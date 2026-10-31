import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  checkEvaluator, evaluate, expectedEvaluator, fileStore, inputSegments, judgeEvaluator, layerSignals, memoryStore, mockProvider, parseDataset,
  replayRuns, run, runMember, scoreLayers, stream, toJsonl, JUDGE_SCHEMA,
  type EvalCase, type EvalScore, type Evaluator, type RunEvent,
} from '../src/index.ts';
import { datasetPath, replayTargets } from '../src/eval/cli.ts';
import { echoTool, makeAgent } from './helpers.ts';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');

/** Runs an agent and returns the evaluator input for it. */
async function observed(agent: ReturnType<typeof makeAgent>, input = 'go') {
  const events: RunEvent[] = [];
  const res = await stream(agent, input, { sinks: [{ onEvent: (e) => void events.push(e) }] }).result;
  return { runId: res.runId, output: res.output, status: res.status, events };
}

const runner = (agent: ReturnType<typeof makeAgent>) => ({ run: (input: string) => runMember(agent, input) });
const byLayer =(scores: EvalScore[]) => Object.fromEntries(scores.map((s) => [s.layer, s]));
const layers = layerSignals();
const c: EvalCase = { id: 'x', input: 'go' };

describe('dataset and results', () => {
  it('parses JSONL and rejects bad lines with their number', () => {
    const cases = parseDataset('{"id":"a","input":"hi","expected":"x","tags":["t"],"layer":"tool"}\n\n{"id":"b","input":"yo"}\n');
    assert.deepEqual(cases.map((x) => x.id), ['a', 'b']);
    assert.throws(() => parseDataset('{"id":"a","input":"hi"}\n{"id":"b"}'), /line 2.*"input"/);
    assert.throws(() => parseDataset('{"id":"a","input":"hi","layer":"nope"}'), /layer/);
    assert.throws(() => parseDataset('{"id":"a","input":"hi","extra":1}'), /unknown field "extra"/);
    assert.throws(() => parseDataset('{"id":"a","input":"1"}\n{"id":"a","input":"2"}'), /duplicate id/);
    assert.throws(() => parseDataset('nope'), /invalid JSON/);
  });

  it('writes one JSON object per line', () => {
    assert.equal(toJsonl([{ a: 1 }, { b: 2 }]), '{"a":1}\n{"b":2}\n');
    assert.equal(toJsonl([]), '');
  });
});

describe('evaluate', () => {
  const cases: EvalCase[] = [
    { id: 'hit', input: 'alpha', expected: 'echo: alpha' },
    { id: 'miss', input: 'beta', expected: { contains: ['beta', 'gamma'] }, layer: 'llm' },
    { id: 'rx', input: 'delta', expected: { regex: '^ECHO', flags: 'i' } },
    { id: 'free', input: 'epsilon' },
  ];

  it('returns contract rows in dataset order, with expected scores', async () => {
    const agent = makeAgent([]);
    const rows = await evaluate({ agent, cases, evaluators: [expectedEvaluator()], concurrency: 3 });
    assert.deepEqual(rows.map((r) => r.id), ['hit', 'miss', 'rx', 'free']);
    for (const r of rows) {
      assert.equal(typeof r.runId, 'string');
      assert.equal(r.status, 'completed');
      assert.match(r.output, /^echo: /);
    }
    assert.deepEqual(rows[0]!.scores.map((s) => [s.metric, s.value]), [['expected', 1]]);
    const miss = rows[1]!.scores[0]!;
    assert.equal(miss.value, 0.5);
    assert.equal(miss.layer, 'llm');
    assert.match(miss.reason!, /gamma/);
    assert.equal(rows[2]!.scores[0]!.value, 1);
    assert.deepEqual(rows[3]!.scores, []);
  });

  it('stores the runs and reports them through onResult', async () => {
    const store = memoryStore();
    const seen: string[] = [];
    const rows = await evaluate({ agent: makeAgent([]), cases: cases.slice(0, 2), store, onResult: (r) => void seen.push(r.id) });
    assert.deepEqual(new Set(seen), new Set(['hit', 'miss']));
    assert.deepEqual(new Set(await store.list!()), new Set(rows.map((r) => r.runId)));
  });

  it('scores a failed run and survives a throwing evaluator', async () => {
    const agent = makeAgent([{ error: { status: 400, message: 'bad request' } }]);
    const broken: Evaluator = { name: 'broken', score: async () => { throw new Error('kaput'); } };
    const [row] = await evaluate({ agent, cases: [{ id: 'f', input: 'go', expected: 'x' }], evaluators: [expectedEvaluator(), layers, broken] });
    assert.equal(row!.status, 'failed');
    const failedBroken = row!.scores.find((s) => s.metric === 'broken')!;
    assert.deepEqual([failedBroken.value, failedBroken.layer], [0, 'eval']);
    assert.match(failedBroken.reason!, /kaput/);
    assert.equal(row!.scores.find((s) => s.metric === 'expected')!.value, 0);
  });

  it('runs concurrent cases at the requested width', async () => {
    let active = 0;
    let peak = 0;
    const provider = mockProvider([() => ({ text: 'ok' })], { loop: true });
    const generate = provider.generate.bind(provider);
    provider.generate = async (req, ctx) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 15));
      try {
        return await generate(req, ctx);
      } finally {
        active--;
      }
    };
    const agent = makeAgent([], { model: { provider, model: 'm' } });
    await evaluate({ agent, cases: cases.map((x) => ({ id: x.id, input: x.input })), concurrency: 2 });
    assert.equal(peak, 2);
  });
});

describe('judgeEvaluator', () => {
  const judged = (script: Parameters<typeof makeAgent>[0], output?: boolean) =>
    judgeEvaluator({ agent: runner(makeAgent(script, output ? { output: { schema: JUDGE_SCHEMA } } : {})) });

  it('returns the judge score and reason (structured and plain JSON)', async () => {
    const run1 = { runId: 'r', output: 'Paris', status: 'completed' as const, events: [] };
    const structured = await judged([{ text: '{"score":0.75,"reason":"close"}' }], true).score({ ...c, layer: 'llm' }, run1);
    assert.deepEqual(structured, [{ metric: 'judge', value: 0.75, layer: 'llm', reason: 'close' }]);
    const plain = await judged([{ text: 'Sure: {"score": 1, "reason": "exact"}' }]).score(c, run1);
    assert.equal(plain[0]!.value, 1);
  });

  it('puts an unusable judge on the eval layer', async () => {
    const [s] = await judged([{ text: 'no idea' }]).score(c, { runId: 'r', output: 'x', status: 'completed', events: [] });
    assert.deepEqual([s!.value, s!.layer], [0, 'eval']);
  });
});

describe('layerSignals attribution', () => {
  it('tool: a failing tool run', async () => {
    const tool = echoTool('echo', { run: () => { throw new Error('boom'); } });
    const agent = makeAgent([{ toolCalls: [{ name: 'echo', args: { text: 'a' } }] }, { text: 'sorry' }], { tools: [tool] });
    const scores = byLayer(await layers.score(c, await observed(agent)));
    assert.equal(scores.tool!.value, 0);
    assert.match(scores.tool!.reason!, /boom/);
    assert.equal(scores.harness!.value, 1);
    assert.equal(scores.llm!.value, 1);
    assert.equal(scores.identity!.value, 1);
  });

  it('tool: partial failures give a fraction, healthy runs 1', async () => {
    let n = 0;
    const tool = echoTool('echo', { run: () => { if (n++ === 0) throw new Error('first fails'); return 'ok'; } });
    const agent = makeAgent([{ toolCalls: [{ name: 'echo', args: { text: 'a' } }, { name: 'echo', args: { text: 'b' } }] }, { text: 'done' }], { tools: [tool] });
    assert.equal(byLayer(await layers.score(c, await observed(agent))).tool!.value, 0.5);
    const ok = makeAgent([{ toolCalls: [{ name: 'echo', args: { text: 'a' } }] }, { text: 'done' }], { tools: [echoTool()] });
    assert.equal(byLayer(await layers.score(c, await observed(ok))).tool!.value, 1);
  });

  it('identity: denied calls are not tool errors', async () => {
    const agent = makeAgent([{ toolCalls: [{ name: 'echo', args: { text: 'a' } }] }, { text: 'cannot' }], {
      tools: [echoTool()], policy: { rules: [{ match: 'echo', action: 'deny', reason: 'not allowed for this role' }] },
    });
    const scores = byLayer(await layers.score(c, await observed(agent)));
    assert.equal(scores.identity!.value, 0);
    assert.match(scores.identity!.reason!, /not allowed/);
    assert.equal(scores.tool!.value, 1);
  });

  it('harness: a budget stop', async () => {
    const agent = makeAgent([{ toolCalls: [{ name: 'echo', args: { text: 'a' } }] }, { text: 'never' }], { tools: [echoTool()], budget: { maxTurns: 1 } });
    const input = await observed(agent);
    assert.equal(input.status, 'stopped');
    const scores = byLayer(await layers.score(c, input));
    assert.equal(scores.harness!.value, 0);
    assert.match(scores.harness!.reason!, /budget:/);
    assert.equal(scores.llm?.value, 1);
  });

  it('harness: compaction degrades a completed run', async () => {
    const input = await observed(makeAgent([{ text: 'ok' }]));
    const events = [...input.events, { runId: input.runId, seq: 99, ts: 0, type: 'compaction', data: { strategy: 'window', beforeTokens: 9, afterTokens: 3, messages: [] } } as RunEvent];
    assert.equal(byLayer(await layers.score(c, { ...input, events })).harness!.value, 0.5);
  });

  it('llm: truncation, structured-output failure and provider errors', async () => {
    const cut = byLayer(await layers.score(c, await observed(makeAgent([{ text: 'cut off', stopReason: 'max_tokens' }]))));
    assert.equal(cut.llm!.value, 0);
    assert.equal(cut.harness!.value, 1);

    const empty = await observed(makeAgent([{ stopReason: 'max_tokens' }]));
    assert.equal(empty.status, 'stopped');
    const ts = byLayer(await layers.score(c, empty));
    assert.equal(ts.llm!.value, 0);
    assert.equal(ts.harness, undefined, 'a model-side stop is not attributed to the harness');

    const schema = { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] };
    const structured = makeAgent([{ text: 'not json' }, { text: 'still not' }], { output: { schema, retries: 1 } });
    const s = await observed(structured);
    assert.equal(s.status, 'failed');
    assert.equal(byLayer(await layers.score(c, s)).llm!.value, 0);

    const recovered = makeAgent([{ text: 'not json' }, { text: '{"n":1}' }], { output: { schema, retries: 1 } });
    const r = await observed(recovered);
    assert.equal(r.status, 'completed');
    assert.equal(byLayer(await layers.score(c, r)).llm!.value, 0.5);

    const broken = await observed(makeAgent([{ error: { status: 503, message: 'HTTP 503 from http://llm/v1: down' } }]));
    assert.equal(broken.status, 'failed');
    assert.equal(byLayer(await layers.score(c, broken)).llm!.value, 0);
  });

  it('guardrail, knowledge and cache: from events when present, absent otherwise', async () => {
    const input = await observed(makeAgent([{ text: 'ok' }]));
    const base = byLayer(await layers.score(c, input));
    for (const l of ['guardrail', 'knowledge', 'cache', 'identity', 'tool']) assert.equal(base[l], undefined, `${l} has no signal`);

    const extra = (type: string, data: unknown) => ({ runId: input.runId, seq: 100, ts: 0, type, data }) as unknown as RunEvent;
    const events = [
      ...input.events,
      extra('guardrail', { stage: 'output', action: 'block', guard: 'pii' }),
      extra('guardrail', { stage: 'input', action: 'allow' }),
      extra('knowledge_retrieval', { query: 'q', passages: [] }),
      extra('knowledge_retrieval', { query: 'q2', passages: [{ id: 'p' }] }),
      extra('mystery_event', { x: 1 }),
      extra('cache', { hit: true }),
      extra('cache', { hit: false }),
    ];
    const scores = byLayer(await layers.score(c, { ...input, events }));
    assert.equal(scores.guardrail!.value, 0.5);
    assert.equal(scores.knowledge!.value, 0.5);
    assert.equal(scores.cache!.value, 0.5);
    assert.equal(scores.harness!.value, 1);
  });

  it('guardrail: a stopped run with a guardrail reason is not a harness failure', async () => {
    const input = await observed(makeAgent([{ text: 'ok' }]));
    const events = input.events.map((e) => (e.type === 'run_end' ? ({ ...e, data: { ...e.data, status: 'stopped', reason: 'guardrail:pii:output' } } as RunEvent) : e));
    const scores = byLayer(await layers.score(c, { ...input, status: 'stopped', events }));
    assert.equal(scores.guardrail!.value, 0);
    assert.equal(scores.harness, undefined);
  });

  it('cache: provider cache token counts count as a signal', async () => {
    const agent = makeAgent([{ text: 'ok', usage: { cacheReadTokens: 50 } }]);
    assert.equal(byLayer(await layers.score(c, await observed(agent))).cache!.value, 1);
  });
});

describe('scoreLayers on a minimal event shape', () => {
  it('works on plain {type, data} events from any runtime', () => {
    const events = [
      { type: 'tool_result', data: { callId: 'a', name: 'search', content: 'HTTP 500', isError: true } },
      { type: 'tool_result', data: { callId: 'b', name: 'search', content: 'ok', isError: false } },
      { type: 'run_end', data: { status: 'completed' } },
    ];
    const scores = byLayer(scoreLayers(events, { status: 'completed' }));
    assert.equal(scores.tool!.value, 0.5);
    assert.equal(scores.harness!.value, 1);
    assert.equal(scores.llm, undefined);
  });
});

describe('checkEvaluator', () => {
  it('accepts the built-in evaluators', async () => {
    assert.deepEqual(await checkEvaluator(layerSignals()), []);
    assert.deepEqual(await checkEvaluator(expectedEvaluator()), []);
    assert.deepEqual(await checkEvaluator(judgeEvaluator({ agent: runner(makeAgent([{ text: '{"score":1,"reason":"ok"}' }], { })) })), [], 'judge');
  });

  it('flags a non-conformant evaluator', async () => {
    const bad: Evaluator = {
      name: '',
      score: async (_c, r) => {
        if (r.status === 'failed') throw new Error('cannot handle failed runs');
        return [{ metric: 'm', value: 7 }, { metric: '', value: 0.5 }, { metric: 'm', value: 1, layer: 'nope' as never }];
      },
    };
    const failures = await checkEvaluator(bad);
    assert.ok(failures.some((f) => /name/.test(f)));
    assert.ok(failures.some((f) => /value.*0\.\.1/.test(f)));
    assert.ok(failures.some((f) => /metric/.test(f)));
    assert.ok(failures.some((f) => /layer/.test(f)));
    assert.ok(failures.some((f) => /threw/.test(f)));
    assert.deepEqual(await checkEvaluator({ name: 'n', score: undefined as never }), ['evaluator.score must be a function']);
  });
});

describe('replay', () => {
  async function seeded() {
    const store = memoryStore();
    const a = await run(makeAgent([{ text: 'old answer' }]), 'question one', { store });
    const b = await run(makeAgent([{ text: 'old two' }]), 'question two', { store });
    return { store, a, b };
  }

  it('extracts the stored inputs', async () => {
    const { store, a } = await seeded();
    const segments = inputSegments(await store.load(a.runId));
    assert.equal(segments.length, 1);
    assert.equal(segments[0]![0]!.parts[0]!.type, 'text');
  });

  it('replays against another model and compares', async () => {
    const { store, a, b } = await seeded();
    const newProvider = mockProvider([{ text: 'new answer' }], { loop: true });
    const target = makeAgent([{ text: 'unused' }]);
    const into = memoryStore();
    const rows = await replayRuns({
      store, runIds: [a.runId, b.runId], agent: target, into,
      overrides: { model: { provider: newProvider, model: 'better-model' } },
    });
    assert.equal(rows.length, 2);
    assert.equal(newProvider.requests.length, 2);
    assert.ok(newProvider.requests.every((r) => r.model === 'better-model'));
    assert.equal(target.provider.requests.length, 0, 'the original model is not called');
    const [r1] = rows;
    assert.equal(r1!.runId, a.runId);
    assert.equal(r1!.input, 'question one');
    assert.equal(r1!.originalOutput, 'old answer');
    assert.equal(r1!.output, 'new answer');
    assert.equal(r1!.changed, true);
    assert.equal(r1!.status, 'completed');
    assert.equal(r1!.originalStatus, 'completed');
    assert.equal(r1!.turns, 1);
    assert.equal(typeof r1!.costUsd, 'number');
    assert.ok((await into.list!()).includes(r1!.replayRunId));
    assert.equal((await store.list!()).length, 2, 'original store untouched');
  });

  it('applies instruction overrides and marks identical outputs unchanged', async () => {
    const { store, a } = await seeded();
    const target = makeAgent([{ text: 'old answer' }]);
    const [row] = await replayRuns({ store, runIds: [a.runId], agent: target, overrides: { instructions: 'Be brief.' } });
    assert.equal(target.provider.requests[0]!.instructions, 'Be brief.');
    assert.equal(row!.changed, false);
  });

  it('replays all top-level runs, skipping member runs, and rejects unknown ids', async () => {
    const { store, a, b } = await seeded();
    await run(makeAgent([{ text: 'child' }]), 'inner task', { store, parentRunId: a.runId });
    const rows = await replayRuns({ store, all: true, agent: makeAgent([], {}) });
    assert.deepEqual(new Set(rows.map((r) => r.runId)), new Set([a.runId, b.runId]));
    await assert.rejects(replayRuns({ store, runIds: ['missing'], agent: makeAgent([]) }), /not found/);
    await assert.rejects(replayRuns({ store, agent: makeAgent([]) }), /runIds or all/);
  });

  it('replays a continued session turn by turn', async () => {
    const store = memoryStore();
    const agent = makeAgent([{ text: 'one' }, { text: 'two' }]);
    const first = await run(agent, 'hello', { store });
    await run(agent, 'and again', { store, runId: first.runId });
    const target = makeAgent([]);
    const [row] = await replayRuns({ store, runIds: [first.runId], agent: target });
    assert.equal(row!.input, 'hello\n---\nand again');
    assert.equal(row!.output, 'echo: and again');
    assert.equal(target.provider.requests.length, 2);
    assert.ok(target.provider.requests[1]!.messages.length > 2, 'second turn sees the first');
  });
});

describe('CLI', () => {
  it('parses dataset and replay arguments', () => {
    assert.equal(datasetPath(['d.jsonl'], {}), 'd.jsonl');
    assert.equal(datasetPath([], { EVAL_DATASET: 'env.jsonl' }), 'env.jsonl');
    assert.throws(() => datasetPath([], {}), /usage: reinloop eval/);
    assert.deepEqual(replayTargets(['r1', 'r2'], {}), { runIds: ['r1', 'r2'], all: false });
    assert.deepEqual(replayTargets([], { all: true }), { all: true });
    assert.throws(() => replayTargets([], {}), /usage: reinloop replay/);
    assert.throws(() => replayTargets(['r1'], { all: true }), /not both/);
  });

  it('runs eval and replay end to end on a mock project', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reinloop-eval-'));
    await writeFile(join(dir, 'reinloop.json'), JSON.stringify({
      providers: {
        mock: { type: 'mock', responses: [] },
        mock2: { type: 'mock', responses: [{ text: 'second model says hi' }], loop: true },
      },
      store: { type: 'file', dir: 'runs' },
      defaultAgent: 'a',
      agents: { a: { model: 'mock/m1', instructions: 'x', tools: [] } },
    }));
    await writeFile(join(dir, 'd.jsonl'), '{"id":"one","input":"hello","expected":"echo: hello"}\n{"id":"two","input":"bye","expected":"nope","layer":"llm"}\n');
    const cli = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8', timeout: 30_000 });

    const ev = cli('eval', 'd.jsonl', '--agent', 'a', '--out', 'results.jsonl');
    assert.equal(ev.status, 0, ev.stderr);
    const rows = (await readFile(join(dir, 'results.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(rows.map((r) => r.id), ['one', 'two']);
    assert.deepEqual(rows.map((r) => r.scores.find((s: EvalScore) => s.metric === 'expected').value), [1, 0]);
    assert.ok(rows[0].scores.some((s: EvalScore) => s.metric === 'harness_health'));

    const stored = await fileStore(join(dir, 'runs')).list!();
    assert.equal(stored.length, 2);

    const rp = cli('replay', '--all', '--model', 'mock2/m2', '--out', 'replay.jsonl');
    assert.notEqual(rp.status, null, rp.stderr);
    // `mock2/m2` is not a built-in preset: the CLI reports it instead of guessing.
    assert.equal(rp.status, 1);
    assert.match(rp.stderr, /mock2|preset|provider/i);

    const same = cli('replay', rows[0].runId, '--out', 'same.jsonl');
    assert.equal(same.status, 0, same.stderr);
    const replayed = JSON.parse((await readFile(join(dir, 'same.jsonl'), 'utf8')).trim());
    assert.equal(replayed.runId, rows[0].runId);
    assert.equal(replayed.changed, false);

    const bad = cli('replay');
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /usage: reinloop replay/);
  });
});
