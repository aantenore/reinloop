import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { agent, agentTool, collectSink, mockProvider, stream, team, type RunEvent } from '../src/index.ts';
import { echoTool } from './helpers.ts';

const m = (script: Parameters<typeof mockProvider>[0]) => ({ provider: mockProvider(script), model: 'mock' });
const broken = (name: string, message = 'boom') => agent({ name, model: m([{ error: { status: 400, message } }]) });

describe('pattern failures', () => {
  it('parallel reports every failed worker in the result and in run_end', async () => {
    const sink = collectSink();
    const res = await team('fan', 'parallel', { workers: [broken('a', 'bad key'), broken('a', 'quota'), broken('b')] }).run('go', { sinks: [sink] });
    assert.equal(res.status, 'failed');
    assert.equal(res.reason, 'all workers failed');
    assert.deepEqual(res.failures!.map(({ name, status, reason }) => ({ name, status, reason })), [
      { name: 'a', status: 'failed', reason: 'bad key' },
      { name: 'a#2', status: 'failed', reason: 'quota' },
      { name: 'b', status: 'failed', reason: 'boom' },
    ]);
    assert.ok(res.failures!.every((f) => typeof f.runId === 'string'));
    const end = sink.events.find((e) => e.type === 'run_end' && e.runId === res.runId)!;
    assert.deepEqual(end.type === 'run_end' && end.data.failures, res.failures);
  });

  it('parallel keeps partial failures on a completed run', async () => {
    const ok = agent({ name: 'ok', model: m([{ text: 'fine' }]) });
    const res = await team('fan', 'parallel', { workers: [ok, broken('bad')] }).run('go');
    assert.equal(res.status, 'completed');
    assert.deepEqual(res.failures!.map((f) => f.name), ['bad']);
    const clean = await team('fan', 'parallel', { workers: [agent({ name: 'ok', model: m([{ text: 'fine' }]) })] }).run('go');
    assert.equal(clean.failures, undefined);
  });

  it('evaluator over a parallel team flattens nested worker failures', async () => {
    const inner = team('council', 'parallel', { workers: [broken('x'), broken('y')] });
    const critic = agent({ name: 'critic', model: m([{ text: '{"pass":true,"feedback":""}' }]) });
    const res = await team('review', 'evaluator', { generator: inner, evaluator: critic }).run('go');
    assert.equal(res.status, 'failed');
    assert.deepEqual(res.failures!.map((f) => f.name), ['council', 'council/x', 'council/y']);
  });

  it('orchestrator collects failed worker runs', async () => {
    const lead = agent({ name: 'lead', model: m([{ toolCalls: [{ name: 'w', args: { task: 't' } }] }, { text: 'done anyway' }]) });
    const res = await team('crew', 'orchestrator', { orchestrator: lead, workers: [broken('w', 'down')] }).run('go');
    assert.equal(res.status, 'completed');
    assert.deepEqual(res.failures!.map(({ name, reason }) => ({ name, reason })), [{ name: 'w', reason: 'down' }]);
  });
});

describe('budget-stopped members', () => {
  const capped = (name: string) =>
    agent({ name, model: m([{ toolCalls: [{ name: 'echo', args: { text: 'x' } }] }, { text: 'never' }]), tools: [echoTool()], budget: { maxTurns: 1 } });
  const ok = (name: string) => agent({ name, model: m([{ text: 'fine' }]) });
  const brief = (fs: Array<{ name: string; status: string; reason?: string }> | undefined) => fs?.map(({ name, status, reason }) => ({ name, status, reason }));

  it('count as failures with their reason in parallel, evaluator over parallel and orchestrator', async () => {
    const stopped = { status: 'stopped', reason: 'budget:maxTurns' };
    const fan = await team('fan', 'parallel', { workers: [ok('a'), capped('b')] }).run('go');
    assert.equal(fan.status, 'completed');
    assert.deepEqual(brief(fan.failures), [{ name: 'b', ...stopped }]);

    const judge = agent({ name: 'judge', model: m([{ text: '{"pass":true,"feedback":""}' }]) });
    const loop = await team('loop', 'evaluator', { generator: team('fan', 'parallel', { workers: [ok('a'), capped('b')] }), evaluator: judge }).run('go');
    assert.equal(loop.status, 'completed');
    assert.deepEqual(brief(loop.failures), [{ name: 'fan/b', ...stopped }]);

    const lead = agent({ name: 'lead', model: m([{ toolCalls: [{ name: 'w', args: { task: 't' } }] }, { text: 'done' }]) });
    const crew = await team('crew', 'orchestrator', { orchestrator: lead, workers: [capped('w')] }).run('go');
    assert.deepEqual(brief(crew.failures), [{ name: 'w', ...stopped }]);
  });
});

describe('delegated run events', () => {
  const lead = (worker: ReturnType<typeof agent>, forwardEvents?: boolean) =>
    agent({
      name: 'lead',
      model: m([{ toolCalls: [{ name: 'w', args: { task: 't' } }] }, { text: 'done' }]),
      tools: [agentTool(worker, { description: 'worker', ...(forwardEvents !== undefined && { forwardEvents }) })],
    });
  const collect = async (h: AsyncIterable<RunEvent>) => {
    const events: RunEvent[] = [];
    for await (const ev of h) events.push(ev);
    return events;
  };

  it('stay out of the parent stream by default (sinks still see them)', async () => {
    const sink = collectSink();
    const h = stream(lead(agent({ name: 'w', model: m([{ text: 'hi' }]) })), 'go', { sinks: [sink] });
    const events = await collect(h);
    assert.ok(events.every((e) => e.runId === h.runId));
    assert.ok(sink.events.some((e) => e.runId !== h.runId && e.parentRunId === h.runId));
  });

  it('are forwarded to the parent stream with parentRunId when opted in', async () => {
    const h = stream(lead(agent({ name: 'w', model: m([{ text: 'hi' }]) }), true), 'go');
    const events = await collect(h);
    const child = events.filter((e) => e.runId !== h.runId);
    assert.ok(child.length > 0);
    assert.ok(child.every((e) => e.parentRunId === h.runId));
    assert.deepEqual([child[0]!.type, child.at(-1)!.type], ['run_start', 'run_end']);
    // forwarded before the parent sees the delegate's result
    const result = events.findIndex((e) => e.runId === h.runId && e.type === 'tool_result');
    assert.ok(events.indexOf(child.at(-1)!) < result);
    assert.equal((await h.result).output, 'done');
  });

  it('orchestrator forwards worker events through the team stream with forwardEvents', async () => {
    const lead = agent({ name: 'lead', model: m([{ toolCalls: [{ name: 'w', args: { task: 't' } }] }, { text: 'done' }]) });
    const crew = team('crew', 'orchestrator', { orchestrator: lead, workers: [agent({ name: 'w', model: m([{ text: 'hi' }]) })] }, { forwardEvents: true });
    const events = await collect(crew.stream('go'));
    const leadRun = events.find((e) => e.type === 'run_start' && e.data.agent === 'lead')!;
    const worker = events.find((e) => e.type === 'run_start' && e.data.agent === 'w');
    assert.equal(worker?.parentRunId, leadRun.runId);
  });
});
