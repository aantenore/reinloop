import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  agentTool, collectSink, defineTool, memoryStore, run,
  type CredentialProvider, type HookContext, type Identity, type RunEvent, type ToolContext,
} from '../src/index.ts';
import { makeAgent } from './helpers.ts';

const TOKEN = 'secret-bearer-token-123';
const identity: Identity = { subject: 'user-1', kind: 'user', roles: ['admin'], token: TOKEN };
const credentials: CredentialProvider = { token: async (audience) => `cred-for-${audience}` };

function probeTool(seen: ToolContext[]) {
  return defineTool({
    name: 'probe',
    description: 'Capture context',
    risk: 'read',
    schema: { type: 'object', properties: {} },
    run(_args, ctx) {
      seen.push(ctx);
      return 'ok';
    },
  });
}

describe('identity', () => {
  it('reaches the tool context, the middleware context and credentials', async () => {
    const seen: ToolContext[] = [];
    const hooks: HookContext[] = [];
    const agent = makeAgent([{ toolCalls: [{ name: 'probe', args: {} }] }, { text: 'done' }], {
      tools: [probeTool(seen)],
      middleware: [{
        beforeModel: (_req, ctx) => void hooks.push(ctx),
        beforeTool: (_call, ctx) => void hooks.push(ctx),
        afterTool: (_res, ctx) => void hooks.push(ctx),
      }],
    });
    const res = await run(agent, 'go', { identity, credentials });
    assert.equal(res.status, 'completed');
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.identity, identity);
    assert.equal(seen[0]!.credentials, credentials);
    assert.equal(await seen[0]!.credentials!.token('api://x'), 'cred-for-api://x');
    assert.ok(hooks.length >= 3);
    assert.ok(hooks.every((h) => h.identity === identity));
  });

  it('is absent when the run has no identity', async () => {
    const seen: ToolContext[] = [];
    const agent = makeAgent([{ toolCalls: [{ name: 'probe', args: {} }] }, { text: 'done' }], { tools: [probeTool(seen)] });
    const sink = collectSink();
    await run(agent, 'go', { sinks: [sink] });
    assert.equal(seen[0]!.identity, undefined);
    assert.equal(seen[0]!.credentials, undefined);
    const start = sink.events.find((e) => e.type === 'run_start') as RunEvent<'run_start'>;
    assert.equal('subject' in start.data, false);
    assert.equal('identityKind' in start.data, false);
  });

  it('is inherited by subagents', async () => {
    const seen: ToolContext[] = [];
    const childHooks: HookContext[] = [];
    const child = makeAgent([{ toolCalls: [{ name: 'probe', args: {} }] }, { text: 'child answer' }], {
      name: 'child',
      tools: [probeTool(seen)],
      middleware: [{ beforeModel: (_req, ctx) => void childHooks.push(ctx) }],
    });
    const parent = makeAgent([{ toolCalls: [{ name: 'child', args: { task: 'sub' } }] }, { text: 'parent done' }], {
      name: 'parent',
      tools: [agentTool(child, { description: 'helper' })],
    });
    const sink = collectSink();
    const res = await run(parent, 'go', { identity, credentials, sinks: [sink] });
    assert.equal(res.output, 'parent done');
    assert.equal(seen[0]!.identity, identity);
    assert.equal(seen[0]!.credentials, credentials);
    assert.ok(childHooks.every((h) => h.identity === identity));
    const starts = sink.events.filter((e) => e.type === 'run_start') as RunEvent<'run_start'>[];
    assert.equal(starts.length, 2);
    assert.ok(starts.every((e) => e.data.subject === 'user-1' && e.data.identityKind === 'user'));
  });

  it('puts subject and kind on run_start and never the token in events', async () => {
    const store = memoryStore();
    const sink = collectSink();
    const agent = makeAgent([{ toolCalls: [{ name: 'probe', args: {} }] }, { text: 'done' }], { tools: [probeTool([])] });
    const res = await run(agent, 'go', { identity, credentials, store, sinks: [sink] });
    const start = sink.events.find((e) => e.type === 'run_start') as RunEvent<'run_start'>;
    assert.equal(start.data.subject, 'user-1');
    assert.equal(start.data.identityKind, 'user');
    assert.ok(sink.events.length > 0);
    assert.ok(!JSON.stringify(sink.events).includes(TOKEN));
    assert.ok(!JSON.stringify(await store.load(res.runId)).includes(TOKEN));
  });
});
