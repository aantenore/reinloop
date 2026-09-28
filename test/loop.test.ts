import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  agentTool, collectSink, defineTool, memoryArtifacts, memoryStore, readArtifactTool, run, stream, windowCompaction,
  type RunEvent,
} from '../src/index.ts';
import { echoTool, makeAgent, sleepTool } from './helpers.ts';

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

  it('validates structured output and retries with feedback', async () => {
    const schema = { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] };
    const ok = await run(makeAgent([{ text: 'not json' }, { text: '```json\n{"n": 3}\n```' }], { output: { schema } }), 'go');
    assert.equal(ok.status, 'completed');
    assert.deepEqual(ok.data, { n: 3 });

    const bad = await run(makeAgent([{ text: '{}' }, { text: '{}' }], { output: { schema, retries: 1 } }), 'go');
    assert.equal(bad.status, 'failed');
    assert.match(bad.reason!, /\$\.n: required/);
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

  it('continues a session with new input', async () => {
    const store = memoryStore();
    const agent = makeAgent([{ text: 'first' }, { text: 'second' }]);
    const a = await run(agent, 'one', { store });
    const b = await run(agent, 'two', { store, runId: a.runId });
    assert.equal(b.output, 'second');
    assert.equal(agent.provider.requests[1]!.messages.length, 3);
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
});
