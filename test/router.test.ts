import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  collectSink, createRegistry, createRuntime, mockProvider, run, routedModel, withRouter,
  type HarnessConfig, type HookContext, type ModelRequest, type ModelRouter,
} from '../src/index.ts';
import { echoTool, makeAgent } from './helpers.ts';

const req = (over: Partial<ModelRequest> = {}): ModelRequest => ({ model: 'm', messages: [], tools: [], ...over });
const ctx = (turns = 0, over: Partial<HookContext['state']> = {}): HookContext => ({
  runId: 'r', agent: 'a', state: { runId: 'r', agent: 'a', messages: [], usage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0, turns, toolCalls: 0, status: 'running', seq: 0, ...over },
});

describe('routedModel', () => {
  it('prices each response with the selected model, not the agent model', async () => {
    const base = mockProvider([{ text: 'cheap', usage: { inputTokens: 1000, outputTokens: 1000 } }], { name: 'base' });
    const other = mockProvider([{ text: 'pricey', usage: { inputTokens: 1000, outputTokens: 1000 } }], { name: 'other' });
    const refs = { 'other/big': { provider: other, model: 'big', pricing: { inputPerMTok: 10, outputPerMTok: 30 } } };
    let pick = 'other/big';
    const agent = withRouter(
      { name: 'a', model: { provider: base, model: 'small', pricing: { inputPerMTok: 1, outputPerMTok: 2 } }, tools: [], middleware: [] },
      { router: { select: () => pick }, resolve: (spec) => refs[spec as keyof typeof refs] },
    );
    const routed = await run(agent, 'hi');
    assert.equal(routed.output, 'pricey');
    assert.ok(Math.abs(routed.costUsd - 0.04) < 1e-12, `selected model pricing: ${routed.costUsd}`);
    pick = 'small';
    const stayed = await run(agent, 'hi');
    assert.equal(stayed.output, 'cheap');
    assert.ok(Math.abs(stayed.costUsd - 0.003) < 1e-12, `agent model pricing: ${stayed.costUsd}`);
  });

  it('routes across providers and shows the choice in the events', async () => {
    const base = mockProvider([{ text: 'from base' }], { name: 'base' });
    const other = mockProvider([{ text: 'from other' }], { name: 'other' });
    const refs = { 'other/m2': { provider: other, model: 'm2', params: { temperature: 0 } } };
    const agent = withRouter(
      { name: 'a', model: { provider: base, model: 'm1' }, tools: [], middleware: [] },
      { router: { select: () => 'other/m2' }, resolve: (spec) => refs[spec as keyof typeof refs] },
    );
    const sink = collectSink();
    const res = await run(agent, 'hi', { sinks: [sink] });
    assert.equal(res.output, 'from other');
    assert.equal(base.requests.length, 0);
    assert.equal(other.requests[0]!.model, 'm2');
    assert.equal(other.requests[0]!.params?.temperature, 0);
    const events = sink.events;
    assert.equal(events.find((e) => e.type === 'model_request')!.data.model, 'other/m2');
    assert.equal(events.find((e) => e.type === 'model_response')!.data.model, 'other/m2');
  });

  it('keeps the base model when the router selects it or declines', async () => {
    const base = mockProvider([{ text: 'one' }, { text: 'two' }], { name: 'base' });
    const { model, middleware } = routedModel({ provider: base, model: 'm1' }, { router: { select: () => 'm1' }, resolve: () => assert.fail('no resolution expected') });
    const res = await run({ name: 'a', model, tools: [], middleware: [middleware] }, 'hi');
    assert.equal(res.output, 'one');
    assert.equal(base.requests[0]!.model, 'm1');
  });

  it('switches model between turns and gives the router the run context', async () => {
    const small = mockProvider([{ toolCalls: [{ name: 'echo', args: { text: 'x' } }] }], { name: 'small' });
    const large = mockProvider([{ text: 'final' }], { name: 'large' });
    const seen: Array<{ agent: string; turns: number; tools: number }> = [];
    const router: ModelRouter = {
      select: (r, c) => (seen.push({ agent: c.agent, turns: c.state.turns, tools: r.tools.length }), c.state.turns === 0 ? 'small/s' : 'large/l'),
    };
    const agent = makeAgent([], { tools: [echoTool()] });
    const routed = withRouter(agent, {
      router,
      resolve: (spec) => (spec === 'small/s' ? { provider: small, model: 's' } : { provider: large, model: 'l' }),
    });
    const res = await run(routed, 'go');
    assert.equal(res.output, 'final');
    assert.deepEqual(seen, [{ agent: 'test', turns: 0, tools: 1 }, { agent: 'test', turns: 1, tools: 1 }]);
    assert.equal(small.requests.length, 1);
    assert.equal(large.requests.length, 1);
  });

  it('fails the run clearly when the router returns nothing', async () => {
    const agent = makeAgent([{ text: 'x' }]);
    const routed = withRouter(agent, { router: { select: () => '' } });
    const res = await run(routed, 'hi');
    assert.equal(res.status, 'failed');
    assert.match(res.reason!, /router returned no model/);
  });
});

describe('router config', () => {
  // Routers come from plugins: a test registry registers one that always picks `model`.
  const registry = () => {
    const r = createRegistry();
    r.routers.set('fixed', (o) => ({ models: [o.model], select: () => o.model as string }) as ModelRouter);
    return r;
  };
  const config = (): HarnessConfig => ({
    providers: { fast: { type: 'mock', responses: [{ text: 'fast answer' }] }, deep: { type: 'mock', responses: [{ text: 'deep answer' }] } },
    models: { quick: { provider: 'fast', model: 'f-1' }, thorough: { provider: 'deep', model: 'd-1' } },
    routers: { pick: { type: 'fixed', model: 'quick' } },
    agents: { main: { model: 'quick', router: 'pick' } },
  });

  it('wires an agent to a named router and records the selected model', async () => {
    const runtime = await createRuntime(config(), { env: {}, registry: registry() });
    const sink = collectSink();
    const res = await runtime.run('main', 'hi', { sinks: [sink] });
    assert.equal(res.output, 'fast answer');
    assert.equal(sink.events.find((e) => e.type === 'model_request')!.data.model, 'quick');
  });

  it('routes to a model served by another configured provider', async () => {
    const cfg = config();
    cfg.routers!.pick = { type: 'fixed', model: 'thorough' };
    const runtime = await createRuntime(cfg, { env: {}, registry: registry() });
    const res = await runtime.run('main', 'hi');
    assert.equal(res.output, 'deep answer');
  });

  it('rejects unknown routers, unknown router models and unregistered router types', async () => {
    const unknown = config();
    unknown.agents!.main!.router = 'nope';
    await assert.rejects(createRuntime(unknown, { env: {}, registry: registry() }), /agents\.main\.router: unknown router "nope"/);
    const badModel = config();
    badModel.routers!.pick = { type: 'fixed', model: 'missing' };
    const runtime = await createRuntime(badModel, { env: {}, registry: registry() });
    await assert.rejects(runtime.agent('main'), /unknown model "missing"/);
    const badType = config();
    badType.routers!.pick = { type: 'rule' };
    await assert.rejects((await createRuntime(badType, { env: {} })).agent('main'), /unknown router "rule" \(none registered; load a plugin.*agent-layers/);
  });
});
