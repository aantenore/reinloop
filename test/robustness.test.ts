import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { agent, memoryStore, mockProvider, run, summarizeCompaction, team, workspaceTools, type RunStore, type ToolContext } from '../src/index.ts';
import { echoTool, makeAgent } from './helpers.ts';

describe('robustness', () => {
  it('stops the run on a store failure and keeps the log a consistent prefix', async () => {
    const inner = memoryStore();
    let appends = 0;
    const flaky: RunStore = {
      append: async (ev) => {
        if (++appends === 3) throw new Error('disk full');
        return inner.append(ev);
      },
      load: inner.load,
    };
    const tool = echoTool();
    const res = await run(makeAgent([{ toolCalls: [{ name: 'echo', args: { text: 'a' } }] }, { text: 'never' }], { tools: [tool] }), 'go', { store: flaky });
    assert.equal(res.status, 'failed');
    assert.match(res.reason!, /store: disk full/);
    const logged = await inner.load(res.runId);
    assert.deepEqual(logged.map((e) => e.seq), logged.map((_, i) => logged[0]!.seq + i), 'no gaps');
  });

  it('counts summarization tokens and cost in usage and budgets', async () => {
    // The same scripted model serves the agent turns and the summarization call, in order.
    const provider = mockProvider([
      { toolCalls: [{ name: 'echo', args: { text: 'x'.repeat(300) } }], usage: { inputTokens: 400, outputTokens: 10 } },
      { text: 'summary', usage: { inputTokens: 1000, outputTokens: 50 } },
      { text: 'done', usage: { inputTokens: 10, outputTokens: 1 } },
    ]);
    const res = await run(
      {
        name: 'c',
        model: { provider, model: 'm', pricing: { inputPerMTok: 1_000_000, outputPerMTok: 1_000_000 } },
        tools: [echoTool()],
        compaction: { strategy: summarizeCompaction({ keepLast: 2 }), thresholdTokens: 300 },
      },
      'go',
    );
    assert.equal(res.status, 'completed');
    assert.equal(res.output, 'done');
    assert.equal(res.usage.inputTokens, 400 + 1000 + 10);
    assert.equal(res.costUsd, res.usage.inputTokens + res.usage.outputTokens);
  });

  it('does not hang on background processes and kills the group on timeout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reinloop-sh3-'));
    const t = workspaceTools({ root });
    const t0 = performance.now();
    const out = (await t.shell!.run({ command: 'sleep 30 & echo started' }, { signal: new AbortController().signal } as ToolContext)) as { content: string };
    assert.match(out.content, /started/);
    assert.ok(performance.now() - t0 < 5000, 'returned without waiting for the background job');
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 100);
    const killed = (await t.shell!.run({ command: 'sleep 30' }, { signal: ctl.signal } as ToolContext)) as { isError: boolean };
    assert.equal(killed.isError, true);
  });

  it('rejects orchestrator workers whose tool name collides with the lead', () => {
    const worker = agent({ name: 'echo', model: 'mock/x' });
    const lead = agent({ name: 'lead', model: 'mock/x', tools: [echoTool()] });
    assert.throws(() => team('t', 'orchestrator', { orchestrator: lead, workers: [worker] }), /collides/);
  });

  it('keeps running parallel workers to completion when one throws', async () => {
    let finished = 0;
    const slow = agent({ name: 'slow', model: { provider: mockProvider([{ text: 'ok', delayMs: 50 }]), model: 'm' } });
    const broken = { ...agent({ name: 'broken', model: 'mock/x' }), kind: 'team', members: [], pattern: 'x', execute: async () => { throw new Error('boom'); } } as never;
    const res = await team('p', 'parallel', { workers: [slow, broken] }).run('go', {
      sinks: [{ onEvent: (e) => void (e.type === 'run_end' && e.parentRunId && finished++) }],
    });
    assert.equal(res.status, 'completed');
    assert.ok(finished >= 1);
  });
});
