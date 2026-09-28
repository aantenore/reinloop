import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { anthropic, mockProvider, openaiCompatible, ProviderError, withFallback, withRetry } from '../src/index.ts';
import type { ModelRequest } from '../src/index.ts';
import { fakeFetch, json, sse } from './helpers.ts';

const signal = new AbortController().signal;
const request: ModelRequest = {
  model: 'm',
  instructions: 'be brief',
  tools: [{ name: 'echo', description: 'Echo', schema: { type: 'object', properties: { text: { type: 'string' } } } }],
  params: { maxTokens: 50, temperature: 0 },
  messages: [
    { role: 'user', parts: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', parts: [{ type: 'tool_call', id: 'c1', name: 'echo', args: { text: 'a' } }] },
    { role: 'tool', parts: [{ type: 'tool_result', callId: 'c1', name: 'echo', content: 'a' }] },
    { role: 'user', parts: [{ type: 'text', text: 'and?' }] },
  ],
};

describe('openai-compatible', () => {
  it('maps requests and parses tool calls', async () => {
    const f = fakeFetch([
      json({
        model: 'm-2025',
        choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 't1', function: { name: 'echo', arguments: '{"text":"b"}' } }] } }],
        usage: { prompt_tokens: 20, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 8 } },
      }),
    ]);
    const p = openaiCompatible({ baseUrl: 'http://x/v1/', apiKey: 'k', fetch: f.impl, maxTokensParam: 'max_completion_tokens' });
    const res = await p.generate(request, { signal });
    const { url, body, headers } = f.requests[0]!;
    assert.equal(url, 'http://x/v1/chat/completions');
    assert.equal(headers.authorization, 'Bearer k');
    assert.equal(body.max_completion_tokens, 50);
    assert.deepEqual(body.messages.map((m: any) => m.role), ['system', 'user', 'assistant', 'tool', 'user']);
    assert.equal(body.messages[2].tool_calls[0].function.arguments, '{"text":"a"}');
    assert.equal(body.tools[0].function.name, 'echo');
    assert.equal(res.stopReason, 'tool_calls');
    assert.deepEqual(res.message.parts[0], { type: 'tool_call', id: 't1', name: 'echo', args: { text: 'b' } });
    assert.deepEqual(res.usage, { inputTokens: 20, outputTokens: 5, cacheReadTokens: 8 });
  });

  it('sends native structured output unless disabled', async () => {
    const reply = json({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] });
    const schema = { type: 'object', properties: {} };
    const f = fakeFetch([reply, reply]);
    await openaiCompatible({ fetch: f.impl }).generate({ ...request, responseSchema: schema }, { signal });
    assert.deepEqual(f.requests[0]!.body.response_format, { type: 'json_schema', json_schema: { name: 'output', schema, strict: false } });
    await openaiCompatible({ fetch: f.impl, structuredOutput: false }).generate({ ...request, responseSchema: schema }, { signal });
    assert.equal(f.requests[1]!.body.response_format, undefined);
  });

  it('assembles streamed text and tool call deltas', async () => {
    const f = fakeFetch([
      sse([
        { data: { model: 'm', choices: [{ delta: { content: 'Hel' } }] } },
        { data: { choices: [{ delta: { content: 'lo' } }] } },
        { data: { choices: [{ delta: { tool_calls: [{ index: 0, id: 't9', function: { name: 'echo', arguments: '{"te' } }] } }] } },
        { data: { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'xt":"z"}' } }] }, finish_reason: 'tool_calls' }] } },
        { data: { choices: [], usage: { prompt_tokens: 3, completion_tokens: 4 } } },
        { data: '[DONE]' },
      ]),
    ]);
    const deltas: string[] = [];
    const res = await openaiCompatible({ fetch: f.impl, stream: true }).generate(request, { signal, onText: (d) => deltas.push(d) });
    assert.equal(f.requests[0]!.body.stream, true);
    assert.deepEqual(deltas, ['Hel', 'lo']);
    assert.equal(res.message.parts[0]!.type === 'text' && res.message.parts[0]!.text, 'Hello');
    assert.deepEqual(res.message.parts[1], { type: 'tool_call', id: 't9', name: 'echo', args: { text: 'z' } });
    assert.deepEqual(res.usage, { inputTokens: 3, outputTokens: 4 });
  });
});

describe('anthropic', () => {
  it('maps messages, merges tool results into user turns and adds cache breakpoints', async () => {
    const f = fakeFetch([
      json({
        model: 'claude-x',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'fine' }],
        usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 },
      }),
    ]);
    const res = await anthropic({ apiKey: 'k', cache: true, fetch: f.impl }).generate(request, { signal });
    const { url, body, headers } = f.requests[0]!;
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    assert.equal(headers['x-api-key'], 'k');
    assert.equal(body.system[0].cache_control.type, 'ephemeral');
    assert.equal(body.tools[0].cache_control.type, 'ephemeral');
    assert.deepEqual(body.messages.map((m: any) => m.role), ['user', 'assistant', 'user']);
    assert.deepEqual(body.messages[2].content.map((c: any) => c.type), ['tool_result', 'text']);
    assert.ok(body.messages[2].content[1].cache_control);
    assert.equal(res.message.parts[0]!.type === 'text' && res.message.parts[0]!.text, 'fine');
    assert.deepEqual(res.usage, { inputTokens: 115, outputTokens: 2, cacheReadTokens: 100, cacheWriteTokens: 10 });
  });

  it('parses the streaming protocol', async () => {
    const f = fakeFetch([
      sse([
        { event: 'message_start', data: { type: 'message_start', message: { model: 'claude-x', usage: { input_tokens: 7, output_tokens: 1 } } } },
        { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
        { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok ' } } },
        { event: 'content_block_start', data: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu1', name: 'echo', input: {} } } },
        { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"text":' } } },
        { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"q"}' } } },
        { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } } },
        { event: 'message_stop', data: { type: 'message_stop' } },
      ]),
    ]);
    const deltas: string[] = [];
    const res = await anthropic({ fetch: f.impl, stream: true }).generate(request, { signal, onText: (d) => deltas.push(d) });
    assert.deepEqual(deltas, ['ok ']);
    assert.equal(res.stopReason, 'tool_calls');
    assert.deepEqual(res.message.parts[1], { type: 'tool_call', id: 'tu1', name: 'echo', args: { text: 'q' } });
    assert.deepEqual(res.usage, { inputTokens: 7, outputTokens: 9 });
  });
});

describe('truncated streams', () => {
  it('reports a stream that ends early as a retryable error, then retries', async () => {
    const cut = sse([{ data: { choices: [{ delta: { content: '' } }] } }]);
    await assert.rejects(openaiCompatible({ fetch: fakeFetch([cut]).impl, stream: true }).generate(request, { signal }), (e: unknown) => e instanceof ProviderError && e.status === 502);
    const acut = sse([{ data: { type: 'message_start', message: { usage: { input_tokens: 1 } } } }]);
    await assert.rejects(anthropic({ fetch: fakeFetch([acut]).impl, stream: true }).generate(request, { signal }), /stream ended before completion/);
    const f = fakeFetch([cut, sse([{ data: { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] } }, { data: '[DONE]' }])]);
    const res = await withRetry(openaiCompatible({ fetch: f.impl, stream: true }), { baseDelayMs: 1 }).generate(request, { signal });
    assert.equal(res.message.parts[0]!.type === 'text' && res.message.parts[0]!.text, 'ok');
  });
});

describe('resilience', () => {
  it('retries retryable errors honouring retry-after, not client errors', async () => {
    const f = fakeFetch([json({ error: 'slow down' }, 429, { 'retry-after-ms': '5' }), json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] })]);
    const res = await withRetry(openaiCompatible({ fetch: f.impl }), { baseDelayMs: 1 }).generate(request, { signal });
    assert.equal(f.requests.length, 2);
    assert.equal(res.message.parts[0]!.type === 'text' && res.message.parts[0]!.text, 'ok');

    const g = fakeFetch([json({ error: 'bad' }, 400), json({})]);
    await assert.rejects(withRetry(openaiCompatible({ fetch: g.impl })).generate(request, { signal }), (e: unknown) => e instanceof ProviderError && e.status === 400);
    assert.equal(g.requests.length, 1);
  });

  it('falls back to the next model and rewrites the model name', async () => {
    const primary = mockProvider([{ error: { status: 503 } }]);
    const backup = mockProvider([{ text: 'from backup' }]);
    const p = withFallback([{ provider: primary, model: 'a' }, { provider: backup, model: 'b' }]);
    const res = await p.generate({ ...request, model: 'a' }, { signal });
    assert.equal(backup.requests[0]!.model, 'b');
    assert.equal(res.message.parts[0]!.type === 'text' && res.message.parts[0]!.text, 'from backup');
  });
});
