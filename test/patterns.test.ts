import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { agent, collectSink, mockProvider, team } from '../src/index.ts';

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
