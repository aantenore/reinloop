import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  agent, agentTool, collectSink, DEFAULT_BUDGET, defineTool, memoryArtifacts, memoryStore, mockProvider, readArtifactTool, replay, run, stream, team, windowCompaction,
  type Agent, type Budget, type MockStep, type RunEvent, type RunStore,
} from '../src/index.ts';
import { echoTool, makeAgent, sleepTool, thinkingAgent } from './helpers.ts';

describe('loop', () => {
  it('completes a text-only run and reports usage', async () => {
    const agent = makeAgent([{ text: 'hello', usage: { inputTokens: 10, outputTokens: 2 } }]);
    const res = await run(agent, 'hi');
    assert.equal(res.status, 'completed');
    assert.equal(res.output, 'hello');
    assert.deepEqual(res.usage, { inputTokens: 10, outputTokens: 2, cacheReadTokens: undefined, cacheWriteTokens: undefined });
    assert.equal(res.turns, 1);
  });

  it('runs tools and feeds results back', async () => {
    const tool = echoTool();
    const agent = makeAgent([{ toolCalls: [{ name: 'echo', args: { text: 'a' } }] }, { text: 'done' }], { tools: [tool] });
    const res = await run(agent, 'go');
    assert.equal(res.status, 'completed');
    assert.equal(tool.calls, 1);
    const second = agent.provider.requests[1]!;
    const result = second.messages.at(-1)!.parts[0]!;
    assert.equal(result.type === 'tool_result' && result.content, 'echoed:a');
  });

  it('executes independent tool calls in parallel', async () => {
    const agent = makeAgent(
      [{ toolCalls: [{ name: 'sleep' }, { name: 'sleep' }, { name: 'sleep' }] }, { text: 'ok' }],
      { tools: [sleepTool(120)] },
    );
    const t0 = performance.now();
    await run(agent, 'go');
    assert.ok(performance.now() - t0 < 300, 'three 120ms calls should overlap');
  });

  it('reports unknown tools and invalid arguments to the model instead of crashing', async () => {
    const agent = makeAgent(
      [{ toolCalls: [{ name: 'nope', args: {} }, { name: 'echo', args: { text: 1 } }] }, { text: 'recovered' }],
      { tools: [echoTool()] },
    );
    const res = await run(agent, 'go');
    assert.equal(res.status, 'completed');
    const results = agent.provider.requests[1]!.messages.filter((m) => m.role === 'tool').map((m) => m.parts[0]);
    assert.match(JSON.stringify(results), /Unknown tool \\"nope\\"/);
    assert.match(JSON.stringify(results), /Invalid arguments: args.text: expected string/);
  });

  it('cuts a hung tool off at toolSettings.timeoutMs and completes the run', async () => {
    // Waits on nothing the event loop holds (no socket, no timer): only the time limit can end it.
    const hung = defineTool({
      name: 'hung',
      description: 'Never settles',
      risk: 'read',
      schema: { type: 'object', properties: {} },
      run: (_args, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted')))),
    });
    const agent = makeAgent([{ toolCalls: [{ name: 'hung', args: {} }] }, { text: 'recovered' }], { tools: [hung], toolSettings: { timeoutMs: 50 } });
    const res = await run(agent, 'go');
    assert.equal(res.status, 'completed');
    const result = agent.provider.requests[1]!.messages.at(-1)!.parts[0]!;
    assert.equal(result.type === 'tool_result' && result.content, 'Tool error: timed out after 50ms');
  });

  it('enforces policy: ask without approver denies, approver allows, rules override', async () => {
    const writer = echoTool('writer', { risk: 'write' });
    const script = () => [{ toolCalls: [{ name: 'writer', args: { text: 'x' } }] }, { text: 'end' }];

    await run(makeAgent(script(), { tools: [writer] }), 'go');
    assert.equal(writer.calls, 0);

    await run(makeAgent(script(), { tools: [writer] }), 'go', { approve: () => true });
    assert.equal(writer.calls, 1);

    await run(makeAgent(script(), { tools: [writer], policy: { rules: [{ match: 'wri*', action: 'deny' }] } }), 'go', { approve: () => true });
    assert.equal(writer.calls, 1);
  });

  it('stops on budget with a machine-readable reason', async () => {
    const agent = makeAgent([{ toolCalls: [{ name: 'echo', args: { text: 'a' } }] }], { tools: [echoTool()], budget: { maxTurns: 1 } });
    const res = await run(agent, 'go');
    assert.equal(res.status, 'stopped');
    assert.equal(res.reason, 'budget:maxTurns');
  });

  it('keeps the default turn limit when a budget sets other limits only; maxTurns: Infinity lifts it', async () => {
    const looping = (budget: Budget): Agent => ({
      name: 'test', model: { provider: mockProvider([{ toolCalls: [{ name: 'echo', args: { text: 'a' } }] }], { loop: true }), model: 'mock-1' }, tools: [echoTool()], budget,
    });
    const res = await run(looping({ maxCostUsd: 1 }), 'go');
    assert.equal(res.status, 'stopped');
    assert.equal(res.reason, 'budget:maxTurns');
    assert.equal(res.turns, DEFAULT_BUDGET.maxTurns);
    // Only the abort ends this run: the loop must yield to the event loop between turns for the timer to fire.
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(new Error('deadline')), 50);
    const unbounded = await run(looping({ maxTurns: Infinity, maxCostUsd: 1 }), 'go', { signal: ctl.signal });
    assert.equal(unbounded.status, 'interrupted');
    assert.equal(unbounded.reason, 'deadline');
    assert.ok(unbounded.turns > DEFAULT_BUDGET.maxTurns!, `ran ${unbounded.turns} turns`);
  });

  it('fails a resume of an unknown run id with a clear reason', async () => {
    const res = await run(makeAgent([{ text: 'x' }]), undefined, { store: memoryStore(), runId: 'nope-1' });
    assert.deepEqual([res.status, res.reason], ['failed', 'unknown run id nope-1']);
    assert.equal((await run(makeAgent([{ text: 'x' }]))).reason, 'no input');
  });

  it('reports a run_end the store could not append through a warning and the result reason', async () => {
    const inner = memoryStore();
    const store: RunStore = {
      append: async (ev) => {
        if (ev.type === 'run_end') throw new Error('disk full');
        return inner.append(ev);
      },
      load: inner.load,
    };
    const warnings: string[] = [];
    const onWarning = (w: Error) => {
      if (w.name === 'ReinloopStoreWarning') warnings.push(w.message);
    };
    process.on('warning', onWarning);
    try {
      const res = await run(makeAgent([{ text: 'done' }]), 'go', { store });
      assert.deepEqual([res.status, res.output, res.reason], ['completed', 'done', 'store: disk full']);
      assert.ok(!(await inner.load(res.runId)).some((e) => e.type === 'run_end'), 'the log lacks run_end');
      const t = await team('t', 'chain', { steps: [agent({ name: 'a', model: { provider: mockProvider([{ text: 'A' }]), model: 'mock' } })] }).run('go', { store });
      assert.deepEqual([t.status, t.output, t.reason], ['completed', 'A', 'store: disk full']);
      await new Promise((r) => setImmediate(r));
      assert.equal(warnings.length, 3, 'agent run, team member run and team run');
      assert.equal(warnings[0], `run ${res.runId}: run_end was not stored (disk full); the log is incomplete`);
    } finally {
      process.off('warning', onWarning);
    }
  });

  it('validates structured output and retries with feedback', async () => {
    const schema = { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] };
    const ok = await run(makeAgent([{ text: 'not json' }, { text: '```json\n{"n": 3}\n```' }], { output: { schema } }), 'go');
    assert.equal(ok.status, 'completed');
    assert.deepEqual(ok.data, { n: 3 });

    const bad = await run(makeAgent([{ text: '{}' }, { text: '{}' }], { output: { schema, retries: 1 } }), 'go');
    assert.equal(bad.status, 'failed');
    assert.match(bad.reason!, /\$\.n: required/);
  });

  it('parses sloppy JSON, unwraps schema echoes and requests native schemas', async () => {
    const schema = { type: 'object', properties: { pass: { type: 'boolean' }, note: { type: 'string' } }, required: ['pass'] };
    const sloppy = makeAgent([{ text: String.raw`Sure! {"pass": true, "note": "d\'uso"} hope it helps` }], { output: { schema } });
    const a = await run(sloppy, 'go');
    assert.deepEqual(a.data, { pass: true, note: "d'uso" });
    assert.deepEqual(sloppy.provider.requests[0]!.responseSchema, schema);
    const echo = await run(makeAgent([{ text: '{"type":"object","properties":{"pass":false}}' }], { output: { schema } }), 'go');
    assert.deepEqual(echo.data, { pass: false });
    const withTools = makeAgent([{ text: 'nope' }, { text: '{"pass":true}' }], { tools: [echoTool()], output: { schema } });
    await run(withTools, 'go');
    assert.deepEqual(withTools.provider.requests[0]!.responseSchema, schema, 'requested even when tools may be called');
    assert.deepEqual(withTools.provider.requests[1]!.responseSchema, schema);
  });

  it('completes a structured run with tools in one turn when the first answer is valid', async () => {
    const schema = { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] };
    const agent = makeAgent([{ text: '{"n": 7}' }], { tools: [echoTool()], output: { schema } });
    const res = await run(agent, 'go');
    assert.equal(res.status, 'completed');
    assert.deepEqual(res.data, { n: 7 });
    assert.equal(res.turns, 1);
    assert.equal(agent.provider.requests.length, 1, 'no OUTPUT_FEEDBACK retry turn');
    assert.deepEqual(agent.provider.requests[0]!.responseSchema, schema);
  });

  it('ends the run when a tool returns stop, without another model turn', async () => {
    const finish = defineTool<{ n: number }>({
      name: 'finish', description: 'Final answer', risk: 'read',
      schema: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] },
      run: ({ n }) => ({ content: `answer ${n}`, stop: true, data: { n } }),
    });
    const echo = echoTool();
    const agent = makeAgent(
      [{ toolCalls: [{ name: 'echo', args: { text: 'a' } }, { name: 'finish', args: { n: 1 } }, { name: 'finish', args: { n: 2 } }] }],
      { tools: [echo, finish] },
    );
    const sink = collectSink();
    const res = await run(agent, 'go', { sinks: [sink] });
    assert.equal(res.status, 'completed');
    assert.equal(res.reason, 'tool:finish');
    assert.equal(res.output, 'answer 1', 'first stop in call order wins');
    assert.deepEqual(res.data, { n: 1 });
    assert.equal(echo.calls, 1, 'the whole batch runs');
    assert.equal(agent.provider.requests.length, 1);
    const end = sink.events.find((e) => e.type === 'run_end')!;
    assert.equal(end.type === 'run_end' && end.data.output, 'answer 1');
    assert.equal(sink.events.filter((e) => e.type === 'tool_result' && e.data.stop).length, 2);

    const failing = defineTool({ name: 'oops', description: 'x', schema: { type: 'object', properties: {} }, run: () => ({ content: 'bad', isError: true, stop: true }) });
    const ignored = await run(makeAgent([{ toolCalls: [{ name: 'oops' }] }, { text: 'recovered' }], { tools: [failing] }), 'go');
    assert.equal(ignored.output, 'recovered', 'error results never stop the run');
  });

  it('validates a stopping tool\'s data against the output schema', async () => {
    const schema = { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] };
    const stopWith = (out: object) => defineTool({ name: 'done', description: 'x', schema: { type: 'object', properties: {} }, run: () => out as never });
    const script = [{ toolCalls: [{ name: 'done' }] }];
    const ok = await run(makeAgent(script, { tools: [stopWith({ content: 'x', stop: true, data: { n: 4 } })], output: { schema } }), 'go');
    assert.deepEqual([ok.status, ok.data], ['completed', { n: 4 }]);
    const parsed = await run(makeAgent(script, { tools: [stopWith({ content: '{"n":5}', stop: true })], output: { schema } }), 'go');
    assert.deepEqual(parsed.data, { n: 5 });
    const bad = await run(makeAgent(script, { tools: [stopWith({ content: 'x', stop: true, data: { n: 'no' } })], output: { schema } }), 'go');
    assert.equal(bad.status, 'failed');
    assert.match(bad.reason!, /invalid structured output from tool done: \$\.n: expected integer/);
  });

  it('resumes a run that crashed after a stopping tool without calling the model', async () => {
    const store = memoryStore();
    const done = defineTool({ name: 'done', description: 'x', schema: { type: 'object', properties: {} }, run: () => ({ content: 'over', stop: true, data: [1] }) });
    const first = await run(makeAgent([{ toolCalls: [{ name: 'done' }] }], { tools: [done] }), 'go', { store });
    const events = await store.load(first.runId);
    const crashed = memoryStore();
    for (const ev of events.filter((e) => e.type !== 'run_end')) await crashed.append(ev);
    const resumed = makeAgent([], { tools: [done] });
    const res = await run(resumed, undefined, { store: crashed, runId: first.runId });
    assert.deepEqual([res.status, res.output, res.data], ['completed', 'over', [1]]);
    assert.equal(resumed.provider.requests.length, 0);

    const continued = makeAgent([{ text: 'next answer' }], { tools: [done] });
    const again = await run(continued, 'more', { store, runId: first.runId });
    assert.equal(again.output, 'next answer', 'a finished stop does not end a continued session');
  });

  it('resumes a crashed run without re-executing completed tools', async () => {
    const store = memoryStore();
    const tool = echoTool();
    const crashing = makeAgent(
      [{ toolCalls: [{ name: 'echo', args: { text: 'a' } }] }, { error: { status: 400, message: 'boom' } }],
      { tools: [tool] },
    );
    const first = await run(crashing, 'go', { store });
    assert.equal(first.status, 'failed');
    assert.equal(tool.calls, 1);

    const healthy = makeAgent([{ text: 'finished' }], { tools: [tool] });
    const second = await run(healthy, undefined, { store, runId: first.runId });
    assert.equal(second.status, 'completed');
    assert.equal(second.output, 'finished');
    assert.equal(tool.calls, 1);
    assert.equal(healthy.provider.requests[0]!.messages.length, 3);
  });

  it('executes only the missing tool calls of an interrupted batch', async () => {
    const store = memoryStore();
    const tool = echoTool();
    const runId = 'r1';
    const call = (id: string) => ({ type: 'tool_call' as const, id, name: 'echo', args: { text: id } });
    const events = [
      { type: 'message', data: { message: { role: 'user', parts: [{ type: 'text', text: 'go' }] }, source: 'input' } },
      { type: 'model_response', data: { turn: 1, model: 'm', message: { role: 'assistant', parts: [call('c1'), call('c2')] }, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'tool_calls', latencyMs: 1, costUsd: 0 } },
      { type: 'tool_result', data: { callId: 'c1', name: 'echo', content: 'echoed:c1', isError: false, durationMs: 1 } },
    ];
    for (const [i, e] of events.entries()) await store.append({ runId, seq: i + 1, ts: 0, ...e } as RunEvent);
    const res = await run(makeAgent([{ text: 'ok' }], { tools: [tool] }), undefined, { store, runId });
    assert.equal(res.status, 'completed');
    assert.equal(tool.calls, 1);
  });

  it('runs the pending tool calls of a crashed batch before new input on resume', async () => {
    const store = memoryStore();
    const tool = echoTool();
    const runId = 'r2';
    const call = (id: string) => ({ type: 'tool_call' as const, id, name: 'echo', args: { text: id } });
    const events = [
      { type: 'message', data: { message: { role: 'user', parts: [{ type: 'text', text: 'go' }] }, source: 'input' } },
      { type: 'model_response', data: { turn: 1, model: 'm', message: { role: 'assistant', parts: [call('c1'), call('c2')] }, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'tool_calls', latencyMs: 1, costUsd: 0 } },
      { type: 'tool_result', data: { callId: 'c1', name: 'echo', content: 'echoed:c1', isError: false, durationMs: 1 } },
    ];
    for (const [i, e] of events.entries()) await store.append({ runId, seq: i + 1, ts: 0, ...e } as RunEvent);
    const agent = makeAgent([{ text: 'ok' }], { tools: [tool] });
    const res = await run(agent, 'new task', { store, runId });
    assert.equal(res.status, 'completed');
    assert.equal(tool.calls, 1, 'only the missing call runs');
    const roles = agent.provider.requests[0]!.messages.map((m) => m.role);
    assert.deepEqual(roles, ['user', 'assistant', 'tool', 'tool', 'user']);
    const results = agent.provider.requests[0]!.messages.flatMap((m) => m.parts.filter((p) => p.type === 'tool_result'));
    assert.deepEqual(results.map((r) => r.type === 'tool_result' && r.callId), ['c1', 'c2']);
  });

  it('enforces maxToolCalls inside a batch: calls over the limit do not run and get an error result', async () => {
    const tool = echoTool();
    const calls = [1, 2, 3, 4].map((n) => ({ name: 'echo', args: { text: String(n) } }));
    const agent = makeAgent([{ toolCalls: calls }, { text: 'never' }], { tools: [tool], budget: { maxToolCalls: 2 } });
    const res = await run(agent, 'go');
    assert.equal(tool.calls, 2);
    assert.deepEqual([res.status, res.reason], ['stopped', 'budget:maxToolCalls']);
    const results = res.messages.flatMap((m) => m.parts.filter((p) => p.type === 'tool_result'));
    assert.equal(results.length, 4, 'every call still gets a result');
    assert.deepEqual(results.map((r) => r.type === 'tool_result' && r.isError), [false, false, true, true]);
    assert.equal(agent.provider.requests.length, 1);
  });

  it('warns once per run when maxCostUsd is set and the model has no pricing', async () => {
    const warnings: string[] = [];
    const onWarning = (w: Error) => {
      if (w.name === 'ReinloopBudgetWarning') warnings.push(w.message);
    };
    process.on('warning', onWarning);
    const looping = (pricing?: { inputPerMTok: number; outputPerMTok: number }): Agent => ({
      name: 'test',
      model: { provider: mockProvider([{ toolCalls: [{ name: 'echo', args: { text: 'a' } }] }, { text: 'done' }]), model: 'mock-1', ...(pricing && { pricing }) },
      tools: [echoTool()],
      budget: { maxCostUsd: 1 },
    });
    try {
      await run(looping(), 'go');
      await run(looping({ inputPerMTok: 1, outputPerMTok: 1 }), 'go');
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(warnings.length, 1, 'two turns, one unpriced run: one warning');
      assert.match(warnings[0]!, /maxCostUsd.*mock-1.*no price/);
    } finally {
      process.off('warning', onWarning);
    }
  });

  it('halts the run on the cost, duration and token limits', async () => {
    const priced = (budget: Budget, step: MockStep = { toolCalls: [{ name: 'echo', args: { text: 'a' } }], usage: { inputTokens: 1000, outputTokens: 1000 } }): Agent => ({
      name: 'test',
      model: { provider: mockProvider([step], { loop: true }), model: 'mock-1', pricing: { inputPerMTok: 1000, outputPerMTok: 1000 } },
      tools: [echoTool()],
      budget: { maxTurns: Infinity, ...budget },
    });
    const cost = await run(priced({ maxCostUsd: 3 }), 'go');
    assert.deepEqual([cost.status, cost.reason, cost.turns], ['stopped', 'budget:maxCostUsd', 2]);
    const total = await run(priced({ maxTotalTokens: 5000 }), 'go');
    assert.deepEqual([total.reason, total.turns], ['budget:maxTotalTokens', 3]);
    const input = await run(priced({ maxInputTokens: 2000 }), 'go');
    assert.deepEqual([input.reason, input.turns], ['budget:maxInputTokens', 2]);
    const output = await run(priced({ maxOutputTokens: 3000 }), 'go');
    assert.deepEqual([output.reason, output.turns], ['budget:maxOutputTokens', 3]);
    const slow = await run(priced({ maxDurationMs: 40 }, { toolCalls: [{ name: 'echo', args: { text: 'a' } }], delayMs: 25 }), 'go');
    assert.equal(slow.reason, 'budget:maxDurationMs');
  });

  it('carries spend and active time over when a run that never ended is resumed; a finished session turn starts fresh', async () => {
    const step = { toolCalls: [{ name: 'echo', args: { text: 'a' } }], usage: { inputTokens: 1000, outputTokens: 1000 } }; // $2 per model call
    const priced = (budget: Budget, script: MockStep[] = [step]) => {
      const provider = mockProvider(script, { loop: true });
      const agent: Agent = { name: 'test', model: { provider, model: 'mock-1', pricing: { inputPerMTok: 1000, outputPerMTok: 1000 } }, tools: [echoTool()], budget: { maxTurns: Infinity, ...budget } };
      return { agent, provider };
    };
    // One turn ($2) that started 10 s before its last event, stored with its run_end (finished) or without (crashed).
    const source = memoryStore();
    const first = await run(priced({ maxTurns: 1 }).agent, 'go', { store: source });
    assert.deepEqual([first.reason, first.costUsd], ['budget:maxTurns', 2]);
    const log = (await source.load(first.runId)).map((ev) => (ev.type === 'run_start' ? { ...ev, ts: ev.ts - 10_000 } : ev));
    const stored = async (ended: boolean) => {
      const store = memoryStore();
      for (const ev of log) if (ended || ev.type !== 'run_end') await store.append(ev);
      return { store, runId: first.runId };
    };

    const resumed = priced({ maxCostUsd: 3 });
    const res = await run(resumed.agent, undefined, await stored(false));
    assert.deepEqual([res.status, res.reason, res.costUsd], ['stopped', 'budget:maxCostUsd', 4]);
    assert.equal(resumed.provider.requests.length, 1, 'the $2 already spent count: one more call, not two');
    const late = priced({ maxDurationMs: 5_000 });
    const timedOut = await run(late.agent, undefined, await stored(false));
    assert.equal(timedOut.reason, 'budget:maxDurationMs', 'the 10 s already active count');
    assert.equal(late.provider.requests.length, 0);

    const turn = priced({ maxCostUsd: 3, maxDurationMs: 5_000 });
    const next = await run(turn.agent, 'more', await stored(true));
    assert.deepEqual([next.reason, next.costUsd], ['budget:maxCostUsd', 6], 'the result total stays cumulative');
    assert.equal(turn.provider.requests.length, 2, 'a new turn on a finished session gets the whole budget again');
  });

  it('retries empty model answers and fails after repeated ones', async () => {
    const ok = makeAgent([{ usage: { inputTokens: 5, outputTokens: 3 } }, { text: 'finally' }]);
    const res = await run(ok, 'go');
    assert.equal(res.output, 'finally');
    assert.equal(res.turns, 2);
    assert.equal(res.messages.filter((m) => m.role === 'assistant').length, 1);
    const bad = await run(makeAgent([{}, {}, {}]), 'go');
    assert.equal(bad.status, 'failed');
    assert.match(bad.reason!, /3 empty responses/);
  });

  it('continues a session with new input', async () => {
    const store = memoryStore();
    const agent = makeAgent([{ text: 'first' }, { text: 'second' }]);
    const a = await run(agent, 'one', { store });
    const b = await run(agent, 'two', { store, runId: a.runId });
    assert.equal(b.output, 'second');
    assert.equal(agent.provider.requests[1]!.messages.length, 3);
  });

  it('holds thinking_delta until afterModel ran when a middleware sets holdsText, and streams it otherwise', async () => {
    const order: string[] = [];
    const sink = { onEvent: (e: RunEvent) => { if (e.type === 'thinking_delta' || e.type === 'text_delta') order.push(e.type); } };
    const holding = { name: 'hold', holdsText: true, afterModel: () => { order.push('afterModel'); return undefined; } };
    await run(thinkingAgent('a b', 'c d', { middleware: [holding] }), 'q', { sinks: [sink] });
    assert.deepEqual(order, ['afterModel', 'thinking_delta', 'text_delta']);

    order.length = 0;
    const plain = { name: 'plain', afterModel: () => { order.push('afterModel'); return undefined; } };
    await run(thinkingAgent('a b', 'c d', { middleware: [plain] }), 'q', { sinks: [sink] });
    assert.deepEqual(order, ['thinking_delta', 'thinking_delta', 'text_delta', 'text_delta', 'afterModel']);
  });

  it('streams events, supports abort and marks the run interrupted', async () => {
    const agent = makeAgent([{ text: 'a b c', delayMs: 10 }]);
    const types: string[] = [];
    for await (const ev of stream(agent, 'hi')) types.push(ev.type);
    assert.ok(types.includes('text_delta'));
    assert.equal(types.at(-1), 'run_end');

    const ctl = new AbortController();
    const slow = makeAgent([{ text: 'late', delayMs: 5_000 }]);
    setTimeout(() => ctl.abort(new Error('stop')), 20);
    const res = await run(slow, 'hi', { signal: ctl.signal });
    assert.equal(res.status, 'interrupted');
  });

  it('applies middleware to requests and tool calls', async () => {
    const tool = echoTool();
    const agent = makeAgent([{ toolCalls: [{ name: 'echo', args: { text: 'x' } }] }, { text: 'done' }], {
      tools: [tool],
      middleware: [
        { beforeModel: (req) => ({ ...req, instructions: 'injected-by-middleware' }) },
        { beforeTool: () => ({ deny: 'blocked by guard' }) },
      ],
    });
    await run(agent, 'go');
    assert.equal(agent.provider.requests[0]!.instructions, 'injected-by-middleware');
    assert.equal(tool.calls, 0);
  });

  it('compacts context without orphaning tool results', async () => {
    const script = Array.from({ length: 6 }, (_, i) => ({ toolCalls: [{ name: 'echo', args: { text: 'x'.repeat(400) + i } }] }));
    const sink = collectSink();
    const agent = makeAgent([...script, { text: 'done' }], {
      tools: [echoTool()],
      compaction: { strategy: windowCompaction({ keepLast: 4 }), thresholdTokens: 300 },
    });
    const res = await run(agent, 'go', { sinks: [sink] });
    assert.equal(res.status, 'completed');
    assert.ok(sink.events.some((e) => e.type === 'compaction'));
    for (const req of agent.provider.requests) {
      const firstNonUser = req.messages.find((m) => m.role !== 'user');
      assert.notEqual(firstNonUser?.role, 'tool', 'tail must not start with a tool result');
    }
  });

  it('offloads oversized tool output to artifacts', async () => {
    const artifacts = memoryArtifacts();
    const big = defineTool({ name: 'big', description: 'big', risk: 'read', schema: { type: 'object' }, run: () => 'y'.repeat(5000) });
    const agent = makeAgent([{ toolCalls: [{ name: 'big' }] }, { text: 'ok' }], {
      tools: [big, readArtifactTool(artifacts)],
      toolSettings: { maxResultChars: 1000, artifacts },
    });
    const sink = collectSink();
    await run(agent, 'go', { sinks: [sink] });
    const result = sink.events.find((e) => e.type === 'tool_result') as RunEvent<'tool_result'>;
    assert.ok(result.data.artifact);
    assert.ok(result.data.content.length < 1200);
    assert.equal((await artifacts.get(result.data.artifact!))!.length, 5000);
  });

  it('delegates to subagents with isolated context and linked events', async () => {
    const child = makeAgent([{ text: 'child answer' }], { name: 'child' });
    const parent = makeAgent([{ toolCalls: [{ name: 'child', args: { task: 'sub task' } }] }, { text: 'parent done' }], {
      name: 'parent',
      tools: [agentTool(child, { description: 'helper' })],
    });
    const sink = collectSink();
    const res = await run(parent, 'go', { sinks: [sink] });
    assert.equal(res.output, 'parent done');
    assert.equal(child.provider.requests[0]!.messages.length, 1);
    assert.ok(sink.events.some((e) => e.parentRunId === res.runId && e.type === 'run_end'));
    const toolResult = sink.events.find((e) => e.type === 'tool_result' && !e.parentRunId) as RunEvent<'tool_result'>;
    assert.equal(toolResult.data.content, 'child answer');
  });

  it('counts a delegated run against the parent budget and caps it at what the parent has left', async () => {
    const pricing = { inputPerMTok: 1000, outputPerMTok: 1000 };
    const usage = { inputTokens: 1000, outputTokens: 1000 }; // $2 per model call
    const child: Agent = {
      name: 'child', tools: [echoTool()], budget: { maxTurns: Infinity, maxCostUsd: 100 },
      model: { provider: mockProvider([{ toolCalls: [{ name: 'echo', args: { text: 'a' } }], usage }], { loop: true }), model: 'mock-1', pricing },
    };
    const parent = makeAgent([{ toolCalls: [{ name: 'child', args: { task: 'sub task' } }], usage }, { text: 'never' }], {
      name: 'parent', tools: [agentTool(child, { description: 'helper' })], budget: { maxCostUsd: 3 },
    });
    parent.model.pricing = pricing;
    const store = memoryStore();
    const sink = collectSink();
    const res = await run(parent, 'go', { store, sinks: [sink] });
    assert.deepEqual([res.status, res.reason, res.turns], ['stopped', 'budget:maxCostUsd', 1]);
    assert.equal(res.costUsd, 4, 'own $2 plus the $2 the child spent');
    assert.deepEqual([res.usage.inputTokens, res.usage.outputTokens], [2000, 2000]);
    const childEnd = sink.events.find((e) => e.type === 'run_end' && e.parentRunId === res.runId) as RunEvent<'run_end'>;
    assert.deepEqual([childEnd.data.reason, childEnd.data.turns], ['budget:maxCostUsd', 1], 'the child stops at the $1 the parent had left, not at its own $100');
    const toolResult = sink.events.find((e) => e.type === 'tool_result' && !e.parentRunId) as RunEvent<'tool_result'>;
    assert.deepEqual([toolResult.data.costUsd, toolResult.data.usage?.inputTokens, toolResult.data.usage?.outputTokens], [2, 1000, 1000]);
    assert.equal(replay(res.runId, 'parent', await store.load(res.runId)).costUsd, 4, 'the stored log folds to the same total');
  });

  it('leaves a delegated run on its own budget when the parent sets no cost, token or time limit', async () => {
    const pricing = { inputPerMTok: 1000, outputPerMTok: 1000 };
    const usage = { inputTokens: 1000, outputTokens: 1000 };
    const step = { toolCalls: [{ name: 'echo', args: { text: 'a' } }], usage };
    const child = makeAgent([step, step, { text: 'child answer', usage }], { name: 'child', tools: [echoTool()] });
    child.model.pricing = pricing;
    let inherited: unknown = 'unset';
    const probe = defineTool({ name: 'probe', description: 'x', schema: { type: 'object', properties: {} }, run: (_args, ctx) => ((inherited = ctx.inherit.budget), 'ok') });
    const parent = makeAgent([{ toolCalls: [{ name: 'child', args: { task: 'sub task' } }, { name: 'probe' }], usage }, { text: 'parent done', usage }], {
      name: 'parent', tools: [agentTool(child, { description: 'helper' }), probe],
    });
    const res = await run(parent, 'go');
    assert.deepEqual([res.status, res.output, res.turns], ['completed', 'parent done', 2]);
    assert.equal(child.provider.requests.length, 3, 'the child ran to its own end');
    assert.equal(inherited, undefined, 'no ceiling is handed down');
    assert.equal(res.costUsd, 6, 'the child cost is still reported in the parent total');
    assert.deepEqual([res.usage.inputTokens, res.usage.outputTokens], [5000, 5000]);
  });
});
