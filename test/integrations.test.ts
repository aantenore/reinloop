import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';
import { mcpTools, mockProvider, otelSink, run, workspaceTools, type OtelSpan, type ToolContext } from '../src/index.ts';

const fixture = new URL('./fixtures/mcp-server.mjs', import.meta.url).pathname;
const ctx = { signal: new AbortController().signal } as ToolContext;

describe('mcp', () => {
  it('lists paginated tools, derives risk and calls them', async () => {
    const { client, tools } = await mcpTools('calc', { command: process.execPath, args: [fixture] });
    try {
      assert.deepEqual(tools.map((t) => [t.name, t.risk]), [['calc__add', 'read'], ['calc__fail', 'exec']]);
      assert.deepEqual(await tools[0]!.run({ a: 2, b: 3 }, ctx), { content: '5', isError: false });
      assert.deepEqual(await tools[1]!.run({}, ctx), { content: 'nope', isError: true });
    } finally {
      await client.close();
    }
  });

  it('reports a server that fails to start', async () => {
    await assert.rejects(mcpTools('bad', { command: process.execPath, args: ['-e', 'process.exit(3)'] }), /exited with code 3/);
  });
});

describe('workspace tools', () => {
  it('confines paths to the workspace, including through symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reinloop-ws-'));
    const outside = await mkdtemp(join(tmpdir(), 'reinloop-out-'));
    await symlink(outside, join(root, 'escape'));
    const t = workspaceTools({ root });
    await t.write_file!.run({ path: 'sub/a.txt', content: 'hi' }, ctx);
    assert.equal(await t.read_file!.run({ path: 'sub/a.txt' }, ctx), 'hi');
    assert.equal(await t.list_dir!.run({}, ctx), 'escape@\nsub/');
    await assert.rejects(async () => t.read_file!.run({ path: '../x' }, ctx), /outside the workspace/);
    await assert.rejects(async () => t.write_file!.run({ path: 'escape/pwn.txt', content: 'x' }, ctx), /outside the workspace/);
  });

  it('runs shell commands with exit status', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reinloop-sh-'));
    const t = workspaceTools({ root });
    assert.deepEqual(await t.shell!.run({ command: 'echo hi' }, ctx), { content: 'exit 0\nhi\n', isError: false });
    assert.equal(((await t.shell!.run({ command: 'exit 4' }, ctx)) as { isError: boolean }).isError, true);
  });
});

describe('otel sink', () => {
  it('emits GenAI semantic-convention spans with parent links', async () => {
    const spans: Array<{ name: string; attrs: Record<string, unknown>; parent?: string; ended: boolean }> = [];
    const tracer = {
      startSpan(name: string, o?: { attributes?: Record<string, unknown> }, context?: unknown) {
        const s = { name, attrs: { ...o?.attributes }, parent: context as string | undefined, ended: false };
        spans.push(s);
        const span: OtelSpan & { name: string } = {
          name,
          setAttribute: (k, v) => void (s.attrs[k] = v),
          setStatus: () => undefined,
          end: () => void (s.ended = true),
        };
        return span;
      },
    };
    const provider = mockProvider([{ text: 'hi', usage: { inputTokens: 3, outputTokens: 1 } }]);
    await run({ name: 'a', model: { provider, model: 'm' }, tools: [] }, 'x', {
      sinks: [otelSink({ tracer, contextWith: (s) => (s as OtelSpan & { name: string }).name })],
    });
    assert.deepEqual(spans.map((s) => s.name), ['invoke_agent a', 'chat m']);
    assert.equal(spans[1]!.parent, 'invoke_agent a');
    assert.equal(spans[1]!.attrs['gen_ai.usage.input_tokens'], 3);
    assert.ok(spans.every((s) => s.ended));
  });
});

describe('cli', () => {
  it('runs an offline agent from config and streams text', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reinloop-cli-'));
    const cfg = join(dir, 'reinloop.json');
    await writeFile(cfg, JSON.stringify({
      providers: { mock: { type: 'mock' } },
      models: { m: { provider: 'mock', model: 'mock' } },
      store: { type: 'file', dir: 'runs' },
      agents: { echo: { model: 'm' } },
    }));
    const exec = promisify(execFile);
    const cli = new URL('../src/cli.ts', import.meta.url).pathname;
    const { stdout } = await exec(process.execPath, [cli, 'run', '-c', cfg, 'hello there']);
    assert.equal(stdout.trim(), 'echo: hello there');
    const runs = await exec(process.execPath, [cli, 'runs', '-c', cfg]);
    const runId = runs.stdout.trim();
    const log = await readFile(join(dir, 'runs', `${runId}.jsonl`), 'utf8');
    assert.match(log, /"type":"run_end"/);
    const validate = await exec(process.execPath, [cli, 'validate', '-c', cfg]);
    assert.match(validate.stdout, /^ok:/);
  });

  it('exits non-zero with a readable config error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reinloop-cli-'));
    await mkdir(dir, { recursive: true });
    const cfg = join(dir, 'bad.json');
    await writeFile(cfg, JSON.stringify({ agents: { a: { model: 'missing' } } }));
    const cli = new URL('../src/cli.ts', import.meta.url).pathname;
    await assert.rejects(promisify(execFile)(process.execPath, [cli, 'validate', '-c', cfg]), (e: { stderr: string; code: number }) =>
      e.code === 1 && /agents\.a\.model: unknown model "missing"/.test(e.stderr));
  });
});

