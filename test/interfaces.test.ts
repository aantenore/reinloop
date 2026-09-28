import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { architect, loadProject, McpClient, mockProvider, serve } from '../src/index.ts';

async function project(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'reinloop-if-'));
  await mkdir(join(dir, 'agents'));
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, 'agents', name), text);
  return dir;
}

describe('http api', () => {
  it('lists agents, runs them as JSON or SSE, and enforces the token', async () => {
    const dir = await project({ 'echo.md': '---\ndescription: Echoes\nmodel: mock/echo\n---\nEcho.' });
    const rt = await loadProject({ cwd: dir, env: {} });
    const served = await serve(rt, { port: 0, token: 't0k' });
    const auth = { authorization: 'Bearer t0k', 'content-type': 'application/json' };
    try {
      assert.equal((await fetch(`${served.url}/v1/agents`)).status, 401);
      const agents = await (await fetch(`${served.url}/v1/agents`, { headers: auth })).json();
      assert.deepEqual(agents.map((a: { name: string }) => a.name), ['echo']);
      const json = await (await fetch(`${served.url}/v1/agents/echo/runs`, { method: 'POST', headers: auth, body: JSON.stringify({ input: 'hi' }) })).json();
      assert.equal(json.output, 'echo: hi');
      const sse = await (await fetch(`${served.url}/v1/agents/echo/runs`, { method: 'POST', headers: { ...auth, accept: 'text/event-stream' }, body: JSON.stringify({ input: 'yo', runId: json.runId }) })).text();
      assert.match(sse, /event: text_delta/);
      assert.match(sse, /event: result\ndata: .*"output":"echo: yo"/);
      const events = await (await fetch(`${served.url}/v1/runs/${json.runId}`, { headers: auth })).json();
      assert.ok(events.filter((e: { type: string }) => e.type === 'run_end').length === 2, 'second call continued the session');
      assert.equal((await fetch(`${served.url}/v1/agents/nope/runs`, { method: 'POST', headers: auth, body: '{}' })).status, 404);
      assert.match(await (await fetch(served.url)).text(), /reinloop console/);
    } finally {
      await served.close();
      await rt.close();
    }
  });
});

describe('mcp server', () => {
  it('exposes agents as MCP tools with sessions', async () => {
    const dir = await project({ 'helper.md': '---\ndescription: Answers questions\nmodel: mock/echo\n---\nHelp.' });
    const cli = new URL('../src/cli.ts', import.meta.url).pathname;
    const client = await McpClient.connect('local', { command: process.execPath, args: [cli, 'mcp'], cwd: dir });
    try {
      const tools = await client.listTools();
      assert.deepEqual(tools.map((t) => [t.name, t.description]), [['helper', 'Answers questions']]);
      const res = await client.callTool('helper', { task: 'ping' });
      assert.deepEqual(res, { content: 'echo: ping', isError: false });
    } finally {
      await client.close();
    }
  });
});

describe('architect', () => {
  it('writes validated agent files and cannot write elsewhere', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reinloop-arch-'));
    const file = '---\ndescription: Summarizes files\nmodel: mock/echo\ntools: [read_file]\n---\nSummarize.';
    const provider = mockProvider([
      { toolCalls: [{ name: 'write_file', args: { path: 'src/evil.md', content: 'x' } }, { name: 'write_file', args: { path: 'agents/../x.md', content: 'x' } }] },
      { toolCalls: [{ name: 'write_file', args: { path: 'agents/summarizer.md', content: file } }] },
      { toolCalls: [{ name: 'validate_project' }] },
      { text: 'Created agents/summarizer.md' },
    ]);
    const res = await architect({ cwd: dir, model: { provider, model: 'mock' } }).run('an agent that summarizes files');
    assert.equal(res.status, 'completed');
    assert.equal(existsSync(join(dir, 'src', 'evil.md')), false);
    assert.equal(existsSync(join(dir, 'x.md')), false);
    assert.equal(await readFile(join(dir, 'agents', 'summarizer.md'), 'utf8'), file);
    const validation = res.messages.flatMap((m) => m.parts).find((p) => p.type === 'tool_result' && p.name === 'validate_project');
    assert.equal(validation?.type === 'tool_result' && validation.content, 'ok: summarizer');
    assert.match(provider.requests[0]!.instructions!, /Patterns:\n- chain:/);
  });
});
