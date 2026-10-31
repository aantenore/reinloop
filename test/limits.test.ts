import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  CONFIG_SCHEMA, checkConfig, createRuntime, interpolate, LIMITS, limitDefault, limitWarnings, loadConfig, serve,
  type Agent, type HarnessConfig, type JsonSchema, type LimitSpec,
} from '../src/index.ts';

const mock = (responses: unknown[] = [{ text: 'done' }]): HarnessConfig['providers'] => ({ mock: { type: 'mock', responses } });

async function configFile(config: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'reinloop-limits-'));
  const path = join(dir, 'reinloop.json');
  await writeFile(path, JSON.stringify(config));
  return path;
}

describe('limits', () => {
  it('rejects values out of range, non-integers, stray strings and "unbounded" where it is not allowed', () => {
    const errors = checkConfig({
      tools: { concurrency: 0, timeoutMs: -5, maxResultChars: 1.5, shellTimeoutMs: 'soon' as never },
      web: { maxResults: 'unbounded' as never },
      mcpServers: { fs: { command: 'x', timeoutMs: 0 } },
      providers: { p: { type: 'anthropic', retry: { maxAttempts: 0 } } },
    });
    assert.deepEqual(errors.sort(), [
      '$.mcpServers.fs.timeoutMs: must be within 1–∞ or "unbounded"',
      '$.providers.p.retry.maxAttempts: must be within 1–∞',
      '$.tools.concurrency: must be within 1–∞',
      '$.tools.maxResultChars: must be an integer (accepted: 100–∞ or "unbounded")',
      '$.tools.shellTimeoutMs: must be a number, "unbounded", or a ${env:NAME} placeholder (accepted: 1–∞ or "unbounded")',
      '$.tools.timeoutMs: must be within 1–∞ or "unbounded"',
      '$.web.maxResults: must not be "unbounded" (accepted: 1–∞)',
    ]);
  });

  it('accepts "unbounded" and placeholders where allowed, and leaves plugin components alone', () => {
    assert.deepEqual(checkConfig({
      tools: { timeoutMs: 'unbounded' as never, maxResultChars: '${env:MAX_CHARS}' as never },
      serve: { maxBodyBytes: 'unbounded' as never },
      // A plugin provider may give `retry.maxAttempts` its own meaning.
      providers: { p: { type: 'my-gateway', retry: { maxAttempts: 0 } } },
    }), []);
  });

  it('accepts "unbounded" request timeouts for built-in providers and OTLP sinks, warns on them, and rejects 0', () => {
    const config = {
      providers: { p: { type: 'openai-compatible', timeoutMs: 'unbounded' as never }, q: { type: 'anthropic', timeoutMs: 500 } },
      sinks: [{ type: 'otlp', exportTimeoutMs: 'unbounded' as never }],
    };
    assert.deepEqual(checkConfig(config), []);
    assert.equal(limitWarnings(config, {}).length, 3);
    assert.deepEqual(limitWarnings({ providers: { p: { type: 'anthropic', timeoutMs: 600_000 } }, sinks: [{ type: 'otlp', exportTimeoutMs: 10_000 }] }, {}), []);
    assert.deepEqual(checkConfig({ providers: { p: { type: 'anthropic', timeoutMs: 0 } }, sinks: [{ type: 'otlp', exportTimeoutMs: 0 }] }).sort(), [
      '$.providers.p.timeoutMs: must be within 1–∞ or "unbounded"',
      '$.sinks[0].exportTimeoutMs: must be within 1–∞ or "unbounded"',
    ]);
  });

  it('turns placeholders and "unbounded" into numbers when the component is built', () => {
    assert.deepEqual(interpolate({ timeoutMs: '${env:T}', workspace: '${env:T}' }, { T: '2500' }, '$.tools'), { timeoutMs: 2500, workspace: '2500' });
    assert.equal(interpolate('unbounded', {}, '$.tools.maxResultChars'), Number.POSITIVE_INFINITY);
    assert.throws(() => interpolate('${env:T}', { T: 'lots' }, '$.tools.concurrency'), /\$\.tools\.concurrency: the value of \$\{env:T\} must be a number/);
    assert.throws(() => interpolate('${env:T}', { T: '0' }, '$.tools.concurrency'), /must be within 1–∞/);
  });

  it('checks resolvable placeholders at load and defers unset ones to build time', async () => {
    const path = await configFile({ tools: { concurrency: '${env:CONC}' } });
    await assert.rejects(loadConfig(path, { env: { CONC: '-1' }, onWarning: () => {} }), /\$\.tools\.concurrency: the value of \$\{env:CONC\} must be within 1–∞/);
    const deferred = await loadConfig(path, { env: {}, onWarning: () => {} });
    await assert.rejects(createRuntime({ ...deferred.config, providers: mock(), agents: { a: { model: 'mock/x' } } }, { env: {} }), /CONC is not set/);
  });

  it('warns at load for unsafe values, through process warnings by default', async () => {
    const path = await configFile({ tools: { shellTimeoutMs: 'unbounded', concurrency: '${env:CONC}' }, serve: { maxBodyBytes: 'unbounded' }, limits: { maxTurns: 'unbounded' } });
    const collected: string[] = [];
    const loaded = await loadConfig(path, { env: { CONC: '500' }, onWarning: (w) => collected.push(w) });
    assert.deepEqual(collected, loaded.warnings);
    assert.equal(collected.length, 4);
    assert.ok(collected.some((w) => w.startsWith('$.tools.shellTimeoutMs is "unbounded", so this limit is off.')));
    assert.ok(collected.some((w) => w.startsWith('$.tools.concurrency: 500 is outside the safe range 1–64.')));
    assert.ok(collected.some((w) => w.startsWith('$.serve.maxBodyBytes is "unbounded"')));
    assert.ok(collected.some((w) => w.startsWith('$.limits.maxTurns is "unbounded"')));

    const emitted: Error[] = [];
    const onWarning = (w: Error) => emitted.push(w);
    process.on('warning', onWarning);
    try {
      await loadConfig(path, { env: { CONC: '8' } });
      await new Promise((r) => setImmediate(r));
    } finally {
      process.off('warning', onWarning);
    }
    assert.equal(emitted.filter((w) => w.name === 'ReinloopConfigWarning').length, 3);
    // Defaults and explicitly safe values raise nothing.
    assert.deepEqual(limitWarnings({ tools: { timeoutMs: 'unbounded' as never, concurrency: 8 } }, {}), []);
  });

  it('applies configured limits: tools, run loop, serve', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reinloop-limits-ws-'));
    await writeFile(join(dir, 'a.txt'), 'match one\n');
    await writeFile(join(dir, 'b.txt'), 'match two\n');
    const rt = await createRuntime(
      {
        providers: mock([{ toolCalls: [{ name: 'find_files', args: { pattern: '*.txt' } }] }, { text: 'done' }]),
        models: { m: { provider: 'mock', model: 'mock-a' } },
        tools: { workspace: dir, maxFindResults: '${env:FIND}' as never, timeoutMs: 'unbounded' as never, searchLineChars: 20 },
        limits: { maxTurns: 7, maxEmptyResponses: 0 },
        serve: { maxBodyBytes: 16 },
        agents: { a: { model: 'm', tools: ['find_files', 'search_files'] } },
      },
      { env: { FIND: '1' } },
    );
    try {
      const agent = (await rt.agent('a')) as Agent;
      assert.deepEqual(agent.budget, { maxTurns: 7 });
      assert.equal(agent.maxEmptyResponses, 0);
      assert.equal(agent.toolSettings?.timeoutMs, Number.POSITIVE_INFINITY);
      const find = agent.tools.find((t) => t.name === 'find_files')!;
      const out = String(await find.run({ pattern: '*.txt' }, { runId: 'r', agent: 'a', signal: new AbortController().signal } as never));
      assert.equal(out.split('\n').length, 1, 'maxFindResults from ${env:FIND}');
      // An unbounded tool timeout runs the call without a timer (no RangeError from AbortSignal.timeout).
      const result = await rt.run('a', 'find');
      assert.equal(result.status, 'completed');

      const served = await serve(rt, { port: 0 });
      try {
        const res = await fetch(`${served.url}/v1/agents/a/runs`, { method: 'POST', body: JSON.stringify({ input: 'more than sixteen bytes' }) });
        assert.equal(res.status, 413, 'serve.maxBodyBytes from the config');
      } finally {
        await served.close();
      }
    } finally {
      await rt.close();
    }
  });

  it('keeps the previous defaults', () => {
    assert.equal(limitDefault('tools.concurrency'), 8);
    assert.equal(limitDefault('tools.maxResultChars'), 32_000);
    assert.equal(limitDefault('tools.shellTimeoutMs'), 120_000);
    assert.equal(limitDefault('tools.timeoutMs'), Number.POSITIVE_INFINITY);
    assert.equal(limitDefault('mcp.timeoutMs'), 60_000);
    assert.equal(limitDefault('serve.maxBodyBytes'), 1_000_000);
    assert.equal(limitDefault('limits.maxTurns'), 50);
    assert.equal(limitDefault('provider.retry.maxAttempts'), 3);
    assert.equal(limitDefault('provider.timeoutMs'), 600_000);
    assert.equal(limitDefault('otlp.exportTimeoutMs'), 10_000);
  });

  it('keeps every default inside its accepted and safe ranges', () => {
    for (const [name, spec] of Object.entries(LIMITS as Record<string, LimitSpec>)) {
      if (spec.warnUnbounded) assert.ok(spec.unbounded, `${name}: warnUnbounded without unbounded`);
      if (spec.default === 'unbounded') {
        assert.ok(spec.unbounded, `${name}: unbounded default but "unbounded" not accepted`);
        continue;
      }
      assert.ok(spec.default >= spec.min && (spec.max === undefined || spec.default <= spec.max), `${name}: default out of range`);
      if (spec.safe) assert.ok(spec.default >= spec.safe[0] && spec.default <= spec.safe[1], `${name}: default outside the safe range`);
    }
  });

  it('declares every limit in the schema and in docs/configuration.md', async () => {
    const docs = await readFile(new URL('../docs/configuration.md', import.meta.url), 'utf8');
    // The schema node at a limit path; 'open' when an enclosing component accepts any option.
    const schemaAt = (path: string): JsonSchema | 'open' | undefined => {
      let node = CONFIG_SCHEMA;
      for (const part of path.replace(/\[\]/g, '.[]').split('.')) {
        const props = node.properties as Record<string, JsonSchema> | undefined;
        const next = part === '[]' ? node.items : part === '<name>' ? node.additionalProperties : (props?.[part] ?? (node.additionalProperties === false ? undefined : 'open'));
        if (next === 'open') return 'open';
        if (!next || typeof next !== 'object') return undefined;
        node = next as JsonSchema;
      }
      return node;
    };
    for (const [name, spec] of Object.entries(LIMITS as Record<string, LimitSpec>)) {
      assert.ok(docs.includes(`\`${spec.path}\``), `${name}: ${spec.path} missing from docs/configuration.md`);
      const node = schemaAt(spec.path);
      assert.ok(node, `${name}: ${spec.path} is rejected by the schema`);
      if (node !== 'open') assert.ok(Array.isArray(node.anyOf), `${name}: the schema at ${spec.path} is not a limit field`);
    }
  });
});
