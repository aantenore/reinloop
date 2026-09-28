import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createRegistry, createRuntime, defineTool, deepMerge, interpolate, loadConfig, loadRuntime, type Agent, type HarnessConfig } from '../src/index.ts';

const fixture = new URL('./fixtures/mcp-server.mjs', import.meta.url).pathname;

const base = (): HarnessConfig => ({
  providers: { mock: { type: 'mock', responses: [{ toolCalls: [{ name: 'helper', args: { task: 't' } }] }, { text: 'parent done' }] }, sub: { type: 'mock' } },
  models: { m: { provider: 'mock', model: 'mock-a' }, s: { provider: 'sub', model: 'mock-b' } },
  agents: {
    main: { model: 'm', tools: ['helper', 'read_*'] },
    helper: { model: 's', asTool: { description: 'Delegate a task' } },
  },
  defaultAgent: 'main',
});

describe('config', () => {
  it('interpolates env placeholders with defaults and clear errors', () => {
    const env = { KEY: 'secret', EMPTY: '' };
    assert.deepEqual(interpolate({ a: '${env:KEY}', b: ['x-${env:NOPE:-dflt}'], c: '${env:EMPTY:-fallback}' }, env), { a: 'secret', b: ['x-dflt'], c: 'fallback' });
    assert.throws(() => interpolate({ p: { k: '${env:MISSING}' } }, env, '$.providers'), /\$\.providers\.p\.k: environment variable MISSING is not set/);
  });

  it('deep-merges objects and replaces arrays', () => {
    assert.deepEqual(deepMerge({ a: { b: 1, c: [1, 2] } }, { a: { c: [3] }, d: 2 }), { a: { b: 1, c: [3] }, d: 2 });
  });

  it('layers extends and profiles, then validates references', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reinloop-cfg-'));
    await writeFile(join(dir, 'base.json'), JSON.stringify(base()));
    await writeFile(join(dir, 'app.json'), JSON.stringify({
      extends: './base.json',
      agents: { main: { budget: { maxTurns: 3 } } },
      profiles: { prod: { agents: { main: { budget: { maxTurns: 9 } } } } },
    }));
    const dev = await loadConfig(join(dir, 'app.json'), { env: {} });
    assert.equal(dev.config.agents!.main!.budget!.maxTurns, 3);
    assert.equal(dev.config.agents!.main!.model, 'm');
    const prod = await loadConfig(join(dir, 'app.json'), { env: { REINLOOP_PROFILE: 'prod' } });
    assert.equal(prod.config.agents!.main!.budget!.maxTurns, 9);
    await writeFile(join(dir, 'bad.json'), JSON.stringify({ agents: { x: { model: 'm', tols: [] } } }));
    await assert.rejects(loadConfig(join(dir, 'bad.json')), /agents\.x\.tols: unknown property[\s\S]*agents\.x\.model: required|agents\.x\.tols: unknown property/);
  });

  it('builds agents with registry tools, subagents and custom plugins', async () => {
    const registry = createRegistry().tool(defineTool({ name: 'read_weather', description: 'w', risk: 'read', schema: { type: 'object' }, run: () => 'sunny' }));
    const runtime = await createRuntime(base(), { registry, env: {} });
    const agent = (await runtime.agent()) as Agent;
    assert.deepEqual(agent.tools.map((t) => t.name).sort(), ['helper', 'read_file', 'read_weather']);
    const res = await runtime.run(undefined, 'go');
    assert.equal(res.output, 'parent done');
    await runtime.close();
  });

  it('rejects unknown tools and agent cycles', async () => {
    const unknown = base();
    unknown.agents!.main!.tools = ['nope'];
    await assert.rejects((await createRuntime(unknown, { env: {} })).agent(), /"nope" matches no registered tool, agent or team/);

    const cyclic = base();
    cyclic.agents!.helper!.tools = ['main'];
    cyclic.agents!.main!.asTool = { description: 'x' };
    await assert.rejects((await createRuntime(cyclic, { env: {} })).agent('main'), /cycle: main -> helper -> main/);
  });

  it('loads plugins and MCP servers from a config file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reinloop-plug-'));
    await writeFile(join(dir, 'plugin.mjs'), `export default (r) => r.middleware.set('tag', () => ({ beforeModel: (req) => ({ ...req, instructions: 'tagged' }) }));`);
    await writeFile(join(dir, 'reinloop.json'), JSON.stringify({
      plugins: ['./plugin.mjs'],
      providers: { mock: { type: 'mock', responses: [{ toolCalls: [{ name: 'calc__add', args: { a: 1, b: 2 } }] }, { text: 'three' }] } },
      models: { m: { provider: 'mock', model: 'x' } },
      mcpServers: { calc: { command: process.execPath, args: [fixture], include: ['add'] } },
      agents: { a: { model: 'm', tools: ['calc__*'], middleware: ['tag'] } },
    }));
    const runtime = await loadRuntime(join(dir, 'reinloop.json'), { env: {} });
    try {
      const agent = (await runtime.agent()) as Agent;
      assert.deepEqual(agent.tools.map((t) => t.name), ['calc__add']);
      const res = await runtime.run(undefined, 'add');
      assert.equal(res.output, 'three');
      const toolMsg = res.messages.find((m) => m.role === 'tool')!.parts[0]!;
      assert.equal(toolMsg.type === 'tool_result' && toolMsg.content, '3');
      assert.equal((agent.model.provider as { requests?: Array<{ instructions?: string }> }).requests?.[0]?.instructions, 'tagged');
    } finally {
      await runtime.close();
    }
  });
});
