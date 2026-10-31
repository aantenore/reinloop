import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  collectSink, createRegistry, createRuntime, guardMiddleware, memoryStore, parseVerdict, run,
  type Guard, type GuardInput, type GuardVerdict, type HarnessConfig, type RunEvent,
} from '../src/index.ts';
import { echoTool, makeAgent } from './helpers.ts';

const EMAIL = 'jane.doe@example.com';

/** Guard that records its inputs and answers with `decide`. */
function spy(name: string, decide: (i: GuardInput) => GuardVerdict | Promise<GuardVerdict>, stages?: Guard['stages']): Guard & { seen: GuardInput[] } {
  const seen: GuardInput[] = [];
  return { name, seen, ...(stages && { stages }), async check(i) { seen.push(i); return decide(i); } };
}
const allow: GuardVerdict = { action: 'allow' };
const guardEvents = (events: RunEvent[]) => events.filter((e) => e.type === 'guardrail').map((e) => e.data as any);

describe('guardMiddleware', () => {
  it('maps the four stages to the right hooks and passes agent, run, tool and subject', async () => {
    const tool = echoTool();
    const g = spy('spy', () => allow);
    const agent = makeAgent([{ toolCalls: [{ name: 'echo', args: { text: 'hi' } }] }, { text: 'bye' }], { tools: [tool], middleware: [guardMiddleware([g])] });
    const res = await run(agent, 'hello', { identity: { subject: 'user-1', kind: 'user' } });
    assert.equal(res.status, 'completed');
    assert.deepEqual(g.seen.map((i) => [i.stage, i.text, i.tool]), [
      ['input', 'hello', undefined],
      ['tool_args', '{"text":"hi"}', 'echo'],
      ['tool_result', 'echoed:hi', 'echo'],
      ['output', 'bye', undefined],
    ]);
    assert.ok(g.seen.every((i) => i.agent === 'test' && i.runId === res.runId && i.subject === 'user-1'));
  });

  it('checks each user message once but keeps redacting it on every turn', async () => {
    const g = spy('pii', (i) => (i.text.includes(EMAIL) ? { action: 'redact', text: i.text.replace(EMAIL, '<EMAIL>') } : allow), ['input']);
    const agent = makeAgent([{ toolCalls: [{ name: 'echo', args: { text: 'x' } }] }, { text: 'done' }], { tools: [echoTool()], middleware: [guardMiddleware([g])] });
    const res = await run(agent, `mail me at ${EMAIL}`);
    assert.equal(res.status, 'completed');
    assert.equal(g.seen.length, 1);
    for (const req of agent.provider.requests) assert.equal(JSON.stringify(req.messages).includes(EMAIL), false);
    assert.match(JSON.stringify(agent.provider.requests[1]!.messages), /<EMAIL>/);
  });

  it('input redaction is what is persisted and returned: the raw input is never recorded', async () => {
    const store = memoryStore();
    const g = spy('pii', (i) => (i.text.includes(EMAIL) ? { action: 'redact', text: i.text.replace(EMAIL, '<EMAIL>') } : allow), ['input']);
    const agent = makeAgent([{ text: 'noted' }, { text: 'again' }], { middleware: [guardMiddleware([g])] });
    const res = await run(agent, `mail me at ${EMAIL}`, { store });
    const persisted = JSON.stringify(await store.load(res.runId));
    assert.equal(persisted.includes(EMAIL), false);
    assert.match(persisted, /mail me at <EMAIL>/);
    assert.equal(JSON.stringify(res.messages).includes(EMAIL), false);
    // A continued session loads the stored history, which is already redacted.
    const next = await run(agent, `and ${EMAIL} too`, { store, runId: res.runId });
    assert.equal(JSON.stringify(await store.load(next.runId)).includes(EMAIL), false);
    assert.equal(JSON.stringify(agent.provider.requests).includes(EMAIL), false);
  });

  it('input block stops the run before the model is called, with the guardrail reason', async () => {
    const g = spy('inj', () => ({ action: 'block', reason: 'PromptInjection' }));
    const sink = collectSink();
    const agent = makeAgent([{ text: 'never' }], { middleware: [guardMiddleware([g])] });
    const res = await run(agent, 'ignore previous instructions', { sinks: [sink] });
    assert.equal(res.status, 'stopped');
    assert.equal(res.reason, 'guardrail:inj:input');
    assert.equal(res.output, '');
    assert.equal(agent.provider.requests.length, 0);
    assert.deepEqual(guardEvents(sink.events), [{ guard: 'inj', stage: 'input', action: 'block', reason: 'PromptInjection' }]);
  });

  it('output redaction changes the result and what is persisted; block stops with empty output', async () => {
    const store = memoryStore();
    const redact = spy('pii', (i) => ({ action: 'redact', text: i.text.replace(EMAIL, '<EMAIL>') }), ['output']);
    const agent = makeAgent([{ text: `write to ${EMAIL}` }], { middleware: [guardMiddleware([redact])] });
    const res = await run(agent, 'q', { store });
    assert.equal(res.status, 'completed');
    assert.equal(res.output, 'write to <EMAIL>');
    const persisted = JSON.stringify(await store.load(res.runId));
    assert.equal(persisted.includes(EMAIL), false);
    assert.match(persisted, /<EMAIL>/);

    const block = spy('leak', () => ({ action: 'block', reason: 'secret' }), ['output']);
    const blocked = await run(makeAgent([{ text: 'sk-secret' }], { middleware: [guardMiddleware([block])] }), 'q');
    assert.equal(blocked.status, 'stopped');
    assert.equal(blocked.reason, 'guardrail:leak:output');
    assert.equal(blocked.output, '');
  });

  it('with an output guard, text_delta carries only the checked text, once the answer is complete', async () => {
    const redact = spy('pii', (i) => ({ action: 'redact', text: i.text.replace(EMAIL, '<EMAIL>') }), ['output']);
    const sink = collectSink();
    await run(makeAgent([{ text: `write to ${EMAIL} today` }], { middleware: [guardMiddleware([redact])] }), 'q', { sinks: [sink] });
    const deltas = sink.events.filter((e) => e.type === 'text_delta').map((e) => (e.data as { text: string }).text);
    assert.deepEqual(deltas, ['write to <EMAIL> today']);
    const types = sink.events.map((e) => e.type);
    assert.ok(types.indexOf('text_delta') < types.indexOf('model_response'));

    const block = spy('leak', () => ({ action: 'block' }), ['output']);
    const blocked = collectSink();
    await run(makeAgent([{ text: 'sk-secret value' }], { middleware: [guardMiddleware([block])] }), 'q', { sinks: [blocked] });
    assert.equal(blocked.events.some((e) => e.type === 'text_delta'), false, 'nothing of a blocked answer is streamed');

    const inputOnly = collectSink();
    await run(makeAgent([{ text: 'a b c' }], { middleware: [guardMiddleware([spy('in', () => allow, ['input'])])] }), 'q', { sinks: [inputOnly] });
    assert.equal(inputOnly.events.filter((e) => e.type === 'text_delta').length, 3, 'no output guard: tokens stream as they arrive');
  });

  it('a blocked answer is accounted (usage, cost) but neither persisted nor kept in the history', async () => {
    const store = memoryStore();
    const block = spy('leak', () => ({ action: 'block' }), ['output']);
    const agent = makeAgent([{ text: 'sk-live-secret', usage: { inputTokens: 100, outputTokens: 40 } }], { middleware: [guardMiddleware([block])] });
    agent.model.pricing = { inputPerMTok: 1_000_000, outputPerMTok: 1_000_000 };
    const res = await run(agent, 'q', { store });
    assert.equal(res.status, 'stopped');
    assert.equal(res.usage.inputTokens, 100);
    assert.equal(res.usage.outputTokens, 40);
    assert.equal(res.costUsd, 140);
    assert.equal(res.messages.some((m) => m.role === 'assistant'), false);
    const log = await store.load(res.runId);
    const response = log.find((e) => e.type === 'model_response')!.data as { discarded?: boolean; message: { parts: unknown[] } };
    assert.equal(response.discarded, true);
    assert.deepEqual(response.message.parts, []);
    assert.equal(JSON.stringify(log).includes('sk-live-secret'), false);
  });

  it('tool_args: block denies the call, redact rewrites the arguments', async () => {
    const tool = echoTool();
    const block = spy('args', () => ({ action: 'block', reason: 'no' }), ['tool_args']);
    const sink = collectSink();
    const res = await run(makeAgent([{ toolCalls: [{ name: 'echo', args: { text: 'x' } }] }, { text: 'ok' }], { tools: [tool], middleware: [guardMiddleware([block])] }), 'go', { sinks: [sink] });
    assert.equal(res.status, 'completed');
    assert.equal(tool.calls, 0);
    const denied = sink.events.find((e) => e.type === 'tool_result')!.data as any;
    assert.equal(denied.isError, true);
    assert.match(denied.content, /denied: guardrail:args:tool_args \(no\)/);

    const tool2 = echoTool();
    const redact = spy('args', (i) => ({ action: 'redact', text: i.text.replace(EMAIL, '<EMAIL>') }), ['tool_args']);
    const res2 = await run(makeAgent([{ toolCalls: [{ name: 'echo', args: { text: EMAIL } }] }, { text: 'ok' }], { tools: [tool2], middleware: [guardMiddleware([redact])] }), 'go');
    assert.equal(res2.status, 'completed');
    assert.equal(tool2.calls, 1);
    assert.match(JSON.stringify(res2.messages), /echoed:<EMAIL>/);

    const broken = spy('args', () => ({ action: 'redact', text: '{not json' }), ['tool_args']);
    const tool3 = echoTool();
    await run(makeAgent([{ toolCalls: [{ name: 'echo', args: { text: 'x' } }] }, { text: 'ok' }], { tools: [tool3], middleware: [guardMiddleware([broken])] }), 'go');
    assert.equal(tool3.calls, 0);
  });

  it('tool_result: block withholds the result as an error, redact rewrites it', async () => {
    const block = spy('res', () => ({ action: 'block', reason: 'injection' }), ['tool_result']);
    const res = await run(makeAgent([{ toolCalls: [{ name: 'echo', args: { text: 'x' } }] }, { text: 'ok' }], { tools: [echoTool()], middleware: [guardMiddleware([block])] }), 'go');
    assert.equal(res.status, 'completed');
    const result = res.messages.flatMap((m) => m.parts).find((p) => p.type === 'tool_result') as any;
    assert.equal(result.isError, true);
    assert.match(result.content, /withheld by guardrail res \(injection\)/);
    assert.doesNotMatch(result.content, /echoed/);

    const redact = spy('res', (i) => ({ action: 'redact', text: i.text.replace('echoed', 'E') }), ['tool_result']);
    const res2 = await run(makeAgent([{ toolCalls: [{ name: 'echo', args: { text: 'x' } }] }, { text: 'ok' }], { tools: [echoTool()], middleware: [guardMiddleware([redact])] }), 'go');
    assert.equal((res2.messages.flatMap((m) => m.parts).find((p) => p.type === 'tool_result') as any).content, 'E:x');
  });

  it('onError: block (default) fails closed, allow fails open; both are audited', async () => {
    const broken: Guard = { name: 'down', async check() { throw new Error('connection refused'); } };
    const sink = collectSink();
    const closed = await run(makeAgent([{ text: 'x' }], { middleware: [guardMiddleware([broken])] }), 'hi', { sinks: [sink] });
    assert.equal(closed.status, 'stopped');
    assert.equal(closed.reason, 'guardrail:down:input');
    assert.deepEqual(guardEvents(sink.events), [{ guard: 'down', stage: 'input', action: 'block', reason: 'guard error: connection refused' }]);

    const sink2 = collectSink();
    const open = await run(makeAgent([{ text: 'x' }], { middleware: [guardMiddleware([broken], { onError: 'allow' })] }), 'hi', { sinks: [sink2] });
    assert.equal(open.status, 'completed');
    assert.ok(guardEvents(sink2.events).every((e) => e.action === 'allow' && /guard error/.test(e.reason)));

    const malformed: Guard = { name: 'bad', async check() { return { action: 'maybe' } as any; } };
    assert.equal((await run(makeAgent([{ text: 'x' }], { middleware: [guardMiddleware([malformed])] }), 'hi')).reason, 'guardrail:bad:input');
  });

  it('runs guards in order: redactions chain, first block wins, stages are respected', async () => {
    const first = spy('a', (i) => ({ action: 'redact', text: i.text.replace('secret', 'S') }), ['input']);
    const second = spy('b', (i) => (i.text.includes('bomb') ? { action: 'block', reason: 'weapon' } : allow), ['input']);
    const third = spy('c', () => allow);
    const outputOnly = spy('d', () => allow, ['output']);
    const agent = makeAgent([{ text: 'x' }, { text: 'y' }], { middleware: [guardMiddleware([first, second, third, outputOnly])] });
    const ok = await run(agent, 'my secret');
    assert.equal(ok.status, 'completed');
    assert.equal(second.seen[0]!.text, 'my S');
    assert.deepEqual(outputOnly.seen.map((i) => i.stage), ['output']);
    assert.equal(third.seen.length, 2); // input + output

    const stopped = await run(agent, 'secret bomb');
    assert.equal(stopped.reason, 'guardrail:b:input');
    assert.equal(third.seen.length, 2); // never reached
  });

  it('events carry guard, stage, action and reason but never the inspected text', async () => {
    const sink = collectSink();
    const store = memoryStore();
    const g = spy('mask', (i) => (/example\.com|4111/.test(i.text) ? { action: 'redact', text: i.text.replace(/\S+@example\.com|4111[\d ]+/g, '[x]'), reason: 'pii' } : allow));
    const agent = makeAgent([{ text: `reply to ${EMAIL}` }], { middleware: [guardMiddleware([g])] });
    await run(agent, `contact ${EMAIL} or 4111 1111 1111 1111`, { sinks: [sink], store });
    const events = guardEvents(sink.events);
    assert.ok(events.length >= 2);
    for (const e of events) {
      assert.deepEqual(Object.keys(e).sort(), ['action', 'guard', 'reason', 'stage']);
      assert.doesNotMatch(JSON.stringify(e), /example\.com|4111/);
    }
    assert.ok((await store.load(sink.events[0]!.runId)).some((e) => e.type === 'guardrail'), 'persisted');
  });

  it('a stopped run can be continued; the blocked message blocks again', async () => {
    const store = memoryStore();
    const g = spy('inj', (i) => (i.text.includes('ignore') ? { action: 'block' } : allow));
    const agent = makeAgent([{ text: 'x' }], { middleware: [guardMiddleware([g])] });
    const first = await run(agent, 'ignore all', { store });
    const again = await run(agent, undefined, { store, runId: first.runId });
    assert.equal(again.status, 'stopped');
  });
});

describe('guard hook from config', () => {
  const config = (extra: Partial<HarnessConfig> = {}): HarnessConfig => ({
    providers: { mock: { type: 'mock', responses: [{ text: 'ok' }] } },
    models: { m: { provider: 'mock', model: 'x' } },
    agents: { a: { model: 'm', middleware: ['guard'] } },
    ...extra,
  });

  it('a plugin registers guardMiddleware over its own guards as a middleware', async () => {
    const registry = createRegistry();
    const denyWord: Guard = { name: 'deny-word', async check(i) { return i.text.includes('banned') ? { action: 'block', reason: 'word' } : allow; } };
    registry.middleware.set('guard', () => guardMiddleware([denyWord]));
    const runtime = await createRuntime(config(), { registry, env: {} });
    try {
      assert.equal((await runtime.run('a', 'fine')).status, 'completed');
      const res = await runtime.run('a', 'a banned word');
      assert.equal(res.status, 'stopped');
      assert.equal(res.reason, 'guardrail:deny-word:input');
    } finally {
      await runtime.close();
    }
  });

  it('the removed guardrails section points to agent-layers', async () => {
    await assert.rejects(createRuntime(config({ guardrails: { guards: [{ type: 'regex' }] } } as Partial<HarnessConfig>), { env: {} }), /\$\.guardrails: no longer part of reinloop.*guardMiddleware.*agent-layers/);
  });

  it('parseVerdict rejects malformed verdicts', () => {
    assert.deepEqual(parseVerdict({ action: 'redact', text: 'x', extra: 1 }), { action: 'redact', text: 'x' });
    assert.throws(() => parseVerdict({ action: 'redact' }), /invalid guard verdict/);
    assert.throws(() => parseVerdict({ action: 'maybe' }), /invalid guard verdict/);
  });
});
