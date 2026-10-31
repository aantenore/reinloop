import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { checkOpenAIEndpoint, checkProvider, mockProvider, type MockStep } from '../src/index.ts';

const ok: MockStep[] = [
  { text: 'pong' },
  { toolCalls: [{ name: 'record_number', args: { n: 42 } }] },
];

describe('checkProvider', () => {
  it('accepts a conforming provider', async () => {
    assert.deepEqual(await checkProvider(mockProvider(ok), { model: 'm' }), []);
  });

  it('reports a provider that throws', async () => {
    const failures = await checkProvider(mockProvider([{ error: { status: 500, message: 'boom' } }, { error: { status: 500, message: 'boom' } }]), { model: 'm' });
    assert.equal(failures.length, 2);
    assert.match(failures[0]!, /text turn: generate\(\) threw: .*boom/);
  });

  it('reports a missing or malformed tool call', async () => {
    const noCall = await checkProvider(mockProvider([{ text: 'pong' }, { text: 'I would rather chat' }]), { model: 'm' });
    assert.match(noCall.join('\n'), /expected a call to "record_number", got none/);
    const badArgs = await checkProvider(mockProvider([{ text: 'pong' }, { toolCalls: [{ name: 'record_number', args: { n: 'forty-two' } }] }]), { model: 'm' });
    assert.match(badArgs.join('\n'), /do not match the schema/);
    const wrongName = await checkProvider(mockProvider([{ text: 'pong' }, { toolCalls: [{ name: 'other', args: {} }] }]), { model: 'm' });
    assert.match(wrongName.join('\n'), /got other/);
  });

  it('reports empty text, wrong stop reasons and missing usage', async () => {
    const empty = await checkProvider(mockProvider([{ text: '', stopReason: 'other' }, ok[1]!]), { model: 'm' });
    assert.match(empty.join('\n'), /empty answer text/);
    assert.match(empty.join('\n'), /expected stopReason "end", got "other"/);
    const noUsage = await checkProvider(mockProvider([{ text: 'pong', usage: { inputTokens: 0, outputTokens: 0 } }, ok[1]!]), { model: 'm' });
    assert.match(noUsage.join('\n'), /usage reports zero tokens/);
    const wrongStop = await checkProvider(mockProvider([ok[0]!, { toolCalls: [{ name: 'record_number', args: { n: 1 } }], stopReason: 'end' }]), { model: 'm' });
    assert.match(wrongStop.join('\n'), /expected stopReason "tool_calls"/);
  });

  it('passes the model and params to the provider', async () => {
    const provider = mockProvider(ok);
    await checkProvider(provider, { model: 'qwen', params: { maxTokens: 64 } });
    assert.ok(provider.requests.every((r) => r.model === 'qwen' && r.params?.maxTokens === 64));
    assert.equal(provider.requests[1]!.tools[0]!.name, 'record_number');
  });
});

describe('checkOpenAIEndpoint', () => {
  /** Minimal Chat Completions server; `toolArgs` is the raw `arguments` string it answers tool requests with. */
  async function serve(toolArgs: string, seen: Array<{ auth?: string; body: any }> = []) {
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw);
        seen.push({ auth: req.headers.authorization, body });
        const message = body.tools
          ? { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'record_number', arguments: toolArgs } }] }
          : { role: 'assistant', content: 'pong' };
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ model: body.model, choices: [{ message, finish_reason: body.tools ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 3 } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/` };
  }

  it('certifies a raw endpoint and sends the key and model', async () => {
    const seen: Array<{ auth?: string; body: any }> = [];
    const { server, baseUrl } = await serve('{"n":42}', seen);
    try {
      assert.deepEqual(await checkOpenAIEndpoint({ baseUrl, apiKey: 'k', model: 'm', params: { maxTokens: 50 } }), []);
      assert.equal(seen.length, 2);
      assert.ok(seen.every((r) => r.auth === 'Bearer k' && r.body.model === 'm' && r.body.max_tokens === 50));
    } finally {
      server.close();
    }
  });

  it('reports malformed tool arguments and HTTP errors', async () => {
    const { server, baseUrl } = await serve('{"n":');
    try {
      assert.match((await checkOpenAIEndpoint({ baseUrl, model: 'm' })).join('\n'), /arguments were not valid JSON/);
    } finally {
      server.close();
    }
    const failures = await checkOpenAIEndpoint({ baseUrl, model: 'm', fetch: async () => new Response('nope', { status: 401 }) });
    assert.equal(failures.length, 2);
    assert.match(failures[0]!, /HTTP 401: nope/);
  });
});
