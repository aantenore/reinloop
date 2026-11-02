import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { request } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { agent, architect, createRuntime, design, jsonlSink, loadProject, McpClient, mockProvider, serve, stream, team, type HarnessConfig, type RunEvent } from '../src/index.ts';

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
    assert.equal(validation?.type === 'tool_result' && validation.content, 'ok');
    assert.match(provider.requests[0]!.instructions!, /Patterns:\n- chain:/);
  });

  it('sends validation errors back until the files are valid', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reinloop-design-'));
    const pinned = '---\ndescription: d\nmodel: groq/some-model\n---\nDo.';
    const fixed = '---\ndescription: d\nmodel: mock/echo\n---\nDo.';
    const provider = mockProvider([
      { toolCalls: [{ name: 'write_file', args: { path: 'agents/a.md', content: pinned } }] },
      { text: 'done' },
      { toolCalls: [{ name: 'write_file', args: { path: 'agents/a.md', content: fixed } }] },
      { text: 'fixed' },
    ]);
    delete process.env.GROQ_API_KEY;
    const { result, problems } = await design('make an agent', { cwd: dir, model: { provider, model: 'mock' } });
    assert.deepEqual(problems, []);
    assert.equal(result.output, 'fixed');
    assert.match(JSON.stringify(provider.requests[2]!.messages), /GROQ_API_KEY is not set/);
  });
});

describe('http api guards', () => {
  const echo = { 'echo.md': '---\ndescription: Echoes\nmodel: mock/echo\n---\nEcho.' };
  const raw = (url: string, headers: Record<string, string>, method = 'GET', path = '/v1/agents', body?: string) =>
    new Promise<number>((resolve, reject) => {
      const u = new URL(url);
      const req = request({ host: u.hostname, port: u.port, path, method, headers }, (res) => (res.resume(), resolve(res.statusCode!)));
      req.on('error', reject);
      req.end(body);
    });
  const json = { 'content-type': 'application/json' };

  it('rejects traversal run ids with 400 and writes no trace outside the directory', async () => {
    const dir = await project(echo);
    const rt = await loadProject({ cwd: dir, env: {} });
    const traces = join(dir, 'traces');
    rt.sinks.push(jsonlSink(traces));
    const served = await serve(rt, { port: 0 });
    const post = (runId: unknown) => fetch(`${served.url}/v1/agents/echo/runs`, { method: 'POST', headers: json, body: JSON.stringify({ input: 'hi', runId }) });
    try {
      for (const bad of ['../escape', '..%2Fescape', 'a/b', '.hidden', 'x'.repeat(129), 7, '']) assert.equal((await post(bad)).status, 400, String(bad));
      assert.deepEqual(readdirSync(traces), []);
      assert.equal(existsSync(join(dir, 'escape.trace.jsonl')), false);
      assert.equal((await post('good-id_1.2')).status, 200);
      assert.deepEqual(readdirSync(traces), ['good-id_1.2.trace.jsonl']);
    } finally {
      await served.close();
      await rt.close();
    }
  });

  it('jsonlSink skips events whose run id is not a safe file name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reinloop-sink-'));
    const sink = jsonlSink(join(dir, 'traces'));
    const ev = (runId: string) => ({ runId, seq: 0, ts: 0, type: 'run_end', data: {} }) as unknown as RunEvent;
    for (const id of ['../x', 'a/b', '..', '.x']) sink.onEvent(ev(id));
    sink.onEvent(ev('ok'));
    assert.deepEqual(readdirSync(join(dir, 'traces')), ['ok.trace.jsonl']);
    assert.equal(existsSync(join(dir, 'x.trace.jsonl')), false);
  });

  it('stream refuses an unsafe caller-supplied run id for agents and teams', () => {
    const a = agent({ name: 'a', model: { provider: mockProvider([{ text: 'x' }]), model: 'mock' } });
    assert.throws(() => stream(a, 'hi', { runId: '../x' }), /invalid runId/);
    assert.throws(() => team('t', 'parallel', { workers: [a] }).stream('hi', { runId: 'a/b' }), /invalid runId/);
  });

  it('403 for a foreign Host; localhost and an allowed host pass', async () => {
    const rt = await loadProject({ cwd: await project(echo), env: {} });
    const served = await serve(rt, { port: 0, allowedHosts: ['proxy.example.com'] });
    const port = new URL(served.url).port;
    try {
      assert.equal(await raw(served.url, { host: `evil.example:${port}` }), 403);
      assert.equal(await raw(served.url, { host: `127.0.0.1.evil.example:${port}` }), 403);
      assert.equal(await raw(served.url, { host: '127.0.0.1' }), 403, 'port must match');
      assert.equal(await raw(served.url, { host: `127.0.0.1:${port}` }), 200);
      assert.equal(await raw(served.url, { host: `localhost:${port}` }), 200);
      assert.equal(await raw(served.url, { host: `[::1]:${port}` }), 200);
      assert.equal(await raw(served.url, { host: 'proxy.example.com' }), 200);
      assert.equal(await raw(served.url, { host: 'proxy.example.com' }, 'GET', '/health'), 200);
      assert.equal(await raw(served.url, { host: 'evil.example' }, 'GET', '/health'), 200, '/health returns no data: exempt from the Host check');
      assert.equal(await raw(served.url, { host: 'evil.example', origin: 'https://evil.example' }, 'GET', '/health'), 200);
      assert.equal(await raw(served.url, { host: 'evil.example' }, 'GET', '/v1/agents'), 403);
      assert.equal(await raw(served.url, { host: 'evil.example' }, 'GET', '/'), 403);
    } finally {
      await served.close();
      await rt.close();
    }
  });

  it('a Host without port means port 80: an allow-list entry name:80 matches it', async () => {
    const rt = await loadProject({ cwd: await project(echo), env: {} });
    const served = await serve(rt, { port: 0, allowedHosts: ['proxy.example.com:80', 'any.example.com'] });
    try {
      assert.equal(await raw(served.url, { host: 'proxy.example.com' }, 'GET', '/v1/agents'), 200);
      assert.equal(await raw(served.url, { host: 'proxy.example.com:80' }, 'GET', '/v1/agents'), 200);
      assert.equal(await raw(served.url, { host: 'proxy.example.com:81' }, 'GET', '/v1/agents'), 403);
      assert.equal(await raw(served.url, { host: 'any.example.com:81' }, 'GET', '/v1/agents'), 200, 'entry without port: any port');
    } finally {
      await served.close();
      await rt.close();
    }
  });

  it('bound to port 80: Host localhost and localhost:80 both pass', async (t) => {
    const rt = await loadProject({ cwd: await project(echo), env: {} });
    let served;
    try {
      served = await serve(rt, { port: 80 });
    } catch (err) {
      await rt.close();
      if (['EACCES', 'EADDRINUSE'].includes((err as NodeJS.ErrnoException).code ?? '') || /already in use/.test((err as Error).message)) return t.skip('port 80 unavailable');
      throw err;
    }
    try {
      assert.equal(await raw(served.url, { host: 'localhost' }, 'GET', '/v1/agents'), 200);
      assert.equal(await raw(served.url, { host: 'localhost:80' }, 'GET', '/v1/agents'), 200);
      assert.equal(await raw(served.url, { host: 'localhost:81' }, 'GET', '/v1/agents'), 403);
    } finally {
      await served.close();
      await rt.close();
    }
  });

  it('GET /v1/runs/:id with an unsafe id is 404 without touching the store', async () => {
    const rt = await loadProject({ cwd: await project(echo), env: {} });
    const loads: string[] = [];
    const load = rt.store.load.bind(rt.store);
    rt.store.load = async (id) => (loads.push(id), load(id));
    const served = await serve(rt, { port: 0 });
    try {
      for (const bad of ['.hidden', 'x'.repeat(129)]) assert.equal(await raw(served.url, {}, 'GET', `/v1/runs/${bad}`), 404, bad);
      assert.deepEqual(loads, []);
      assert.equal(await raw(served.url, {}, 'GET', '/v1/runs/ok-id'), 200);
      assert.deepEqual(loads, ['ok-id']);
    } finally {
      await served.close();
      await rt.close();
    }
  });

  it('409 for a second request on a run id while the first is running; the id is free again afterwards', async () => {
    const rt = await createRuntime({
      providers: { mock: { type: 'mock', responses: [{ text: 'slow', delayMs: 200 }], loop: true } },
      models: { m: { provider: 'mock', model: 'mock-1' } },
      agents: { echo: { model: 'm', description: 'Echo' } },
    } as HarnessConfig, { env: {} });
    const served = await serve(rt, { port: 0 });
    const post = (runId: string) => fetch(`${served.url}/v1/agents/echo/runs`, { method: 'POST', headers: json, body: JSON.stringify({ input: 'hi', runId }) });
    try {
      const results = await Promise.all([post('same-id'), post('same-id'), post('same-id')]);
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409]);
      const busy = results.find((r) => r.status === 409)!;
      assert.match(((await busy.json()) as { error: string }).error, /run busy/);
      assert.equal((await post('same-id')).status, 200, 'released after the run');
      const other = await Promise.all([post('id-a'), post('id-b')]);
      assert.deepEqual(other.map((r) => r.status), [200, 200], 'different ids do not block each other');
    } finally {
      await served.close();
      await rt.close();
    }
  });

  it('403 for a foreign Origin; allowed, own and absent Origin pass', async () => {
    const rt = await loadProject({ cwd: await project(echo), env: {} });
    const served = await serve(rt, { port: 0, allowedOrigins: ['https://app.example.com'] });
    const get = (origin?: string) => fetch(`${served.url}/v1/agents`, { headers: origin ? { origin } : {} }).then((r) => r.status);
    try {
      assert.equal(await get('https://evil.example'), 403);
      assert.equal(await get('null'), 403);
      assert.equal(await get('https://app.example.com'), 200);
      assert.equal(await get(served.url), 200, 'the console on this server');
      assert.equal(await get(), 200);
    } finally {
      await served.close();
      await rt.close();
    }
    const closed = await serve(rt, { port: 0 });
    try {
      assert.equal((await fetch(`${closed.url}/v1/agents`, { headers: { origin: 'https://app.example.com' } })).status, 403, 'no origin allowed by default');
    } finally {
      await closed.close();
    }
  });

  it('415 for a POST that is not JSON', async () => {
    const rt = await loadProject({ cwd: await project(echo), env: {} });
    const served = await serve(rt, { port: 0 });
    const post = (type?: string) =>
      fetch(`${served.url}/v1/agents/echo/runs`, { method: 'POST', headers: type ? { 'content-type': type } : {}, body: JSON.stringify({ input: 'hi' }) }).then((r) => r.status);
    try {
      assert.equal(await post('text/plain'), 415);
      assert.equal(await post('application/x-www-form-urlencoded'), 415);
      assert.equal(await post('application/jsonx'), 415);
      assert.equal(await post('multipart/form-data; boundary=x'), 415);
      assert.equal(await post('application/json; charset=utf-8'), 200);
      assert.equal(await post('Application/JSON'), 200);
    } finally {
      await served.close();
      await rt.close();
    }
  });

  it('refuses to start on a non-loopback host without authentication unless insecure', async () => {
    const rt = await loadProject({ cwd: await project(echo), env: {} });
    try {
      await assert.rejects(serve(rt, { port: 0, host: '0.0.0.0' }), /refusing to serve on 0\.0\.0\.0 without authentication.*--insecure/);
      for (const options of [{ token: 't' }, { insecure: true }]) {
        const served = await serve(rt, { port: 0, host: '0.0.0.0', ...options });
        await served.close();
      }
      const local = await serve(rt, { port: 0, host: 'localhost' });
      await local.close();
    } finally {
      await rt.close();
    }
  });
});
