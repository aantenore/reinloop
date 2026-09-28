import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { discoverSkills, loadProject, mockProvider, otlpSink, run, skillTool, type Agent, type ToolContext } from '../src/index.ts';

const ctx = { signal: new AbortController().signal } as ToolContext;

async function skillsDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'reinloop-skills-'));
  await mkdir(join(dir, 'skills', 'release-notes', 'reference'), { recursive: true });
  await writeFile(join(dir, 'skills', 'release-notes', 'SKILL.md'), '---\nname: release-notes\ndescription: Write release notes from a list of merged changes\n---\n# Release notes\nGroup changes by type. See reference/style.md.');
  await writeFile(join(dir, 'skills', 'release-notes', 'reference', 'style.md'), 'Use past tense.');
  await mkdir(join(dir, 'skills', 'broken'));
  await writeFile(join(dir, 'skills', 'broken', 'SKILL.md'), '---\nname: broken\n---\nno description');
  return dir;
}

describe('agent skills', () => {
  it('discovers SKILL.md folders and discloses them progressively', async () => {
    const dir = await skillsDir();
    await assert.rejects(discoverSkills(['skills'], dir), /"description" is required/);
    await writeFile(join(dir, 'skills', 'broken', 'SKILL.md'), '---\ndescription: fixed\n---\nok');
    const skills = await discoverSkills(['skills'], dir);
    assert.deepEqual(skills.map((s) => s.name), ['broken', 'release-notes']);
    const tool = skillTool(skills);
    assert.match(tool.description, /- release-notes: Write release notes/);
    const loaded = (await tool.run({ name: 'release-notes' }, ctx)) as string;
    assert.match(loaded, /Group changes by type/);
    assert.match(loaded, /- reference\/style.md/);
    assert.equal(await tool.run({ name: 'release-notes', file: 'reference/style.md' }, ctx), 'Use past tense.');
    await assert.rejects(async () => tool.run({ name: 'release-notes', file: '../broken/SKILL.md' }, ctx), /outside the workspace/);
  });

  it('attaches selected skills to agents declared in files', async () => {
    const dir = await skillsDir();
    await writeFile(join(dir, 'skills', 'broken', 'SKILL.md'), '---\ndescription: fixed\n---\nok');
    await mkdir(join(dir, 'agents'));
    await writeFile(join(dir, 'agents', 'writer.md'), '---\nmodel: mock/echo\nskills: [release-*]\n---\nWrite.');
    const rt = await loadProject({ cwd: dir, env: {} });
    try {
      const writer = (await rt.agent('writer')) as Agent;
      const tool = writer.tools.find((t) => t.name === 'skill')!;
      assert.deepEqual((tool.schema.properties as { name: { enum: string[] } }).name.enum, ['release-notes']);
    } finally {
      await rt.close();
    }
  });
});

describe('otlp sink', () => {
  it('exports linked spans as OTLP/HTTP JSON', async () => {
    const bodies: any[] = [];
    const server = createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        bodies.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(data) });
        res.end('{}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    const sink = otlpSink({ endpoint: `http://127.0.0.1:${port}`, headers: { authorization: 'Basic x' } });
    const provider = mockProvider([{ toolCalls: [{ name: 'noop' }] }, { text: 'ok' }]);
    const noop = { name: 'noop', description: 'n', risk: 'read' as const, schema: { type: 'object' }, run: () => 'done' };
    await run({ name: 'traced', model: { provider, model: 'm' }, tools: [noop] }, 'go', { sinks: [sink] });
    await sink.close!();
    server.close();
    assert.equal(bodies[0].url, '/v1/traces');
    assert.equal(bodies[0].auth, 'Basic x');
    const spans = bodies.flatMap((b) => b.body.resourceSpans[0].scopeSpans[0].spans);
    const root = spans.find((s: any) => s.name === 'invoke_agent traced');
    assert.deepEqual(spans.map((s: any) => s.name).sort(), ['chat m', 'chat m', 'execute_tool noop', 'invoke_agent traced']);
    assert.ok(spans.every((s: any) => s.traceId === root.traceId));
    assert.ok(spans.filter((s: any) => s !== root).every((s: any) => s.parentSpanId === root.spanId));
    const chat = spans.find((s: any) => s.name === 'chat m');
    assert.equal(chat.kind, 3);
    assert.ok(chat.attributes.some((a: any) => a.key === 'gen_ai.usage.input_tokens' && a.value.intValue));
  });
});

describe('integration catalogue', () => {
  it('adds MCP servers, gateways and sinks to a config that still validates', async () => {
    const { addIntegration, INTEGRATIONS, loadConfig } = await import('../src/index.ts');
    const { readFile } = await import('node:fs/promises');
    const dir = await mkdtemp(join(tmpdir(), 'reinloop-add-'));
    const cfg = join(dir, 'reinloop.json');
    for (const name of ['qdrant', 'github', 'litellm', 'otel']) await addIntegration(name, { configPath: cfg });
    await assert.rejects(addIntegration('qdrant', { configPath: cfg }), /already exists/);
    const written = JSON.parse(await readFile(cfg, 'utf8'));
    assert.deepEqual(Object.keys(written.mcpServers), ['qdrant', 'github']);
    assert.equal(written.providers.litellm.type, 'openai-compatible');
    assert.equal(written.sinks[0].type, 'otlp');
    const { config } = await loadConfig(cfg, { env: {} });
    assert.ok(config.mcpServers?.qdrant);
    for (const [name, it] of Object.entries(INTEGRATIONS)) assert.ok(it.source.startsWith('https://'), name);
  });
});
