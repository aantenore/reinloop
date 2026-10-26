import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { anthropic, createRuntime, mockProvider, openaiCompatible, presetProvider, ProviderError, run, withFallback, withRetry, type Agent } from '../src/index.ts';
import type { ModelRequest } from '../src/index.ts';
import { echoTool, fakeFetch, json, sse } from './helpers.ts';

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

  it("skips the schema next to tools in 'without-tools' mode", async () => {
    const reply = json({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] });
    const schema = { type: 'object', properties: {} };
    const f = fakeFetch([reply, reply]);
    const p = openaiCompatible({ fetch: f.impl, structuredOutput: 'without-tools' });
    await p.generate({ ...request, responseSchema: schema }, { signal });
    assert.equal(f.requests[0]!.body.response_format, undefined);
    await p.generate({ ...request, tools: [], responseSchema: schema }, { signal });
    assert.equal(f.requests[1]!.body.response_format.type, 'json_schema');
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
    const res = await anthropic({ apiKey: 'k', cache: true, cacheMinTokens: 0, fetch: f.impl }).generate(request, { signal });
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

  it('sends structured output next to tools, closing objects and keeping output_config from extra', async () => {
    const reply = json({ model: 'claude-x', stop_reason: 'end_turn', content: [{ type: 'text', text: '{"n":1}' }], usage: {} });
    const schema = { type: 'object', properties: { n: { type: 'integer' }, tags: { type: 'array', items: { type: 'object', properties: { k: { type: 'string' } } } } } };
    const f = fakeFetch([reply, reply]);
    const params = { ...request.params, extra: { output_config: { effort: 'low' } } };
    await anthropic({ fetch: f.impl }).generate({ ...request, params, responseSchema: schema }, { signal });
    const { body } = f.requests[0]!;
    assert.equal(body.tools.length, 1);
    assert.equal(body.tool_choice, undefined);
    assert.equal(body.output_config.effort, 'low');
    assert.equal(body.output_config.format.type, 'json_schema');
    assert.equal(body.output_config.format.schema.additionalProperties, false);
    assert.equal(body.output_config.format.schema.properties.tags.items.additionalProperties, false);
    assert.equal((schema as any).additionalProperties, undefined, 'caller schema untouched');
    await anthropic({ fetch: f.impl, structuredOutput: false }).generate({ ...request, responseSchema: schema }, { signal });
    assert.equal(f.requests[1]!.body.output_config, undefined);
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

describe('preset headers', () => {
  const stopped = () => sse([
    { data: { type: 'message_start', message: { model: 'claude-x', usage: { input_tokens: 1 } } } },
    { data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'ok' } } },
    { data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } } },
    { data: { type: 'message_stop' } },
  ])();
  const withFetch = async (fn: (f: ReturnType<typeof fakeFetch>) => Promise<void>) => {
    const f = fakeFetch([stopped, stopped]);
    const original = globalThis.fetch;
    globalThis.fetch = f.impl as typeof fetch;
    try {
      await fn(f);
    } finally {
      globalThis.fetch = original;
    }
  };

  it('maps ANTHROPIC_WORKSPACE_ID to the anthropic-workspace-id header, and config headers on top', async () => {
    await withFetch(async (f) => {
      await presetProvider('anthropic', { ANTHROPIC_API_KEY: 'k', ANTHROPIC_WORKSPACE_ID: 'ws_1' }).generate(request, { signal });
      assert.equal(f.requests[0]!.headers['anthropic-workspace-id'], 'ws_1');
      assert.equal(f.requests[0]!.headers['x-api-key'], 'k');

      const runtime = await createRuntime(
        { presets: { anthropic: { headers: { 'x-team': '${env:TEAM}' } } }, agents: { a: { model: 'anthropic/claude-x' } } },
        { env: { ANTHROPIC_API_KEY: 'k', TEAM: 'blue' } },
      );
      await ((await runtime.agent('a')) as Agent).model.provider.generate(request, { signal });
      assert.equal(f.requests[1]!.headers['x-team'], 'blue');
      assert.equal(f.requests[1]!.headers['anthropic-workspace-id'], undefined);
    });
    await assert.rejects(createRuntime({ presets: { nope: {} } }), /\$\.presets\.nope: unknown preset/);
  });
});

describe('anthropic thinking', () => {
  const usage = { input_tokens: 10, output_tokens: 300 };
  const thinkingAgent = (f: ReturnType<typeof fakeFetch>, extra: Partial<Agent> = {}): Agent => ({
    name: 'a', model: { provider: anthropic({ fetch: f.impl }), model: 'claude-haiku-5-5', params: { maxTokens: 300 } }, tools: [echoTool()], ...extra,
  });

  it('reports a thinking-only max_tokens stop as max_tokens, without retrying', async () => {
    const f = fakeFetch([json({ model: 'm', content: [{ type: 'thinking', thinking: '', signature: 'sig' }], stop_reason: 'max_tokens', usage })]);
    const res = await run(thinkingAgent(f), 'hi');
    assert.equal(f.requests.length, 1);
    assert.equal(res.status, 'stopped');
    assert.equal(res.reason, 'max_tokens');
    assert.equal(res.output, '');
    assert.equal(res.messages.length, 1); // the reasoning-only answer stays out of the history
  });

  it('ends on an empty refusal instead of retrying', async () => {
    const f = fakeFetch([json({ model: 'm', content: [], stop_reason: 'refusal', usage })]);
    const res = await run(thinkingAgent(f), 'hi');
    assert.equal(f.requests.length, 1);
    assert.deepEqual([res.status, res.reason], ['failed', 'refusal']);
  });

  it('keeps thinking blocks with their signature and echoes them back unchanged with tool use', async () => {
    const f = fakeFetch([
      json({
        model: 'm', stop_reason: 'tool_use', usage,
        content: [
          { type: 'thinking', thinking: '', signature: 'sig-1' },
          { type: 'redacted_thinking', data: 'opaque' },
          { type: 'tool_use', id: 'tu1', name: 'echo', input: { text: 'x' } },
        ],
      }),
      json({ model: 'm', stop_reason: 'end_turn', usage, content: [{ type: 'thinking', thinking: 'why', signature: 'sig-2' }, { type: 'text', text: 'done' }] }),
    ]);
    const res = await run(thinkingAgent(f), 'hi');
    assert.equal(res.status, 'completed');
    assert.equal(res.output, 'done');
    assert.deepEqual(f.requests[1]!.body.messages[1], {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '', signature: 'sig-1' },
        { type: 'redacted_thinking', data: 'opaque' },
        { type: 'tool_use', id: 'tu1', name: 'echo', input: { text: 'x' } },
      ],
    });
    assert.deepEqual(res.messages.at(-1)!.parts[0], { type: 'thinking', text: 'why', signature: 'sig-2' });
  });

  it('assembles streamed thinking and signature deltas', async () => {
    const f = fakeFetch([
      sse([
        { data: { type: 'message_start', message: { model: 'm', usage: { input_tokens: 5, output_tokens: 1 } } } },
        { data: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } } },
        { data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'plan' } } },
        { data: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-s' } } },
        { data: { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 300 } } },
        { data: { type: 'message_stop' } },
      ]),
    ]);
    const res = await anthropic({ fetch: f.impl, stream: true }).generate(request, { signal });
    assert.equal(res.stopReason, 'max_tokens');
    assert.deepEqual(res.message.parts, [{ type: 'thinking', text: 'plan', signature: 'sig-s' }]);
  });

  it('maps thinking and effort params, merging effort with the structured output format', async () => {
    const f = fakeFetch([json({ model: 'm', stop_reason: 'end_turn', usage, content: [{ type: 'text', text: '{}' }] })]);
    const params = { maxTokens: 300, thinking: { type: 'adaptive' as const, display: 'summarized' as const }, effort: 'low' as const, extra: { output_config: { task_budget: 1 } } };
    await anthropic({ fetch: f.impl }).generate({ ...request, model: 'claude-haiku-5-5', params, responseSchema: { type: 'object' } }, { signal });
    const { body } = f.requests[0]!;
    assert.deepEqual(body.thinking, { type: 'adaptive', display: 'summarized' });
    assert.deepEqual(Object.keys(body.output_config).sort(), ['effort', 'format', 'task_budget']);
    assert.equal(body.output_config.effort, 'low');
  });

  it('rejects thinking settings the model does not accept, before any request', async () => {
    const f = fakeFetch([]);
    const p = anthropic({ fetch: f.impl });
    const gen = (model: string, params: object) => p.generate({ ...request, model, params }, { signal });
    await assert.rejects(gen('claude-opus-5-5', { thinking: { type: 'disabled' } }), /does not accept thinking type "disabled"/);
    await assert.rejects(gen('claude-opus-5-5', { thinking: { type: 'enabled', budgetTokens: 2048 } }), /does not accept/);
    await assert.rejects(gen('claude-haiku-5-5', { thinking: { type: 'disabled' }, effort: 'xhigh' }), /only with effort high or below/);
    assert.equal(f.requests.length, 0);
    const ok = fakeFetch([json({ model: 'm', stop_reason: 'end_turn', usage, content: [{ type: 'text', text: 'ok' }] })]);
    await anthropic({ fetch: ok.impl }).generate({ ...request, model: 'claude-haiku-5-5', params: { thinking: { type: 'disabled' }, effort: 'high' } }, { signal });
    assert.deepEqual(ok.requests[0]!.body.thinking, { type: 'disabled' });
  });

  it('emits thinking_delta events apart from text, streaming and not', async () => {
    const plain = fakeFetch([json({ model: 'm', stop_reason: 'end_turn', usage, content: [{ type: 'thinking', thinking: 'hmm', signature: 's' }, { type: 'text', text: 'hi' }] })]);
    const streamed = fakeFetch([
      sse([
        { data: { type: 'message_start', message: { model: 'm', usage: {} } } },
        { data: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } },
        { data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } } },
        { data: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 's' } } },
        { data: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } },
        { data: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'hi' } } },
        { data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } } },
        { data: { type: 'message_stop' } },
      ]),
    ]);
    for (const [f, stream] of [[plain, false], [streamed, true]] as const) {
      const agent: Agent = { name: 'a', model: { provider: anthropic({ fetch: f.impl, stream }), model: 'm' }, tools: [] };
      const events: Array<[string, string]> = [];
      const res = await run(agent, 'q', { sinks: [{ onEvent: (e) => (e.type === 'thinking_delta' || e.type === 'text_delta') && events.push([e.type, e.data.text]) }] });
      assert.equal(res.output, 'hi');
      assert.deepEqual(events.filter(([t]) => t === 'thinking_delta'), [['thinking_delta', 'hmm']], `stream=${stream}`);
    }
  });

  it('repeats a max_tokens stop once with retryMaxTokens when configured', async () => {
    const thinkingOnly = json({ model: 'm', content: [{ type: 'thinking', thinking: '', signature: 'sig' }], stop_reason: 'max_tokens', usage });
    const f = fakeFetch([thinkingOnly, json({ model: 'm', stop_reason: 'end_turn', usage, content: [{ type: 'text', text: 'ok' }] })]);
    const a = thinkingAgent(f);
    const res = await run({ ...a, model: { ...a.model, params: { maxTokens: 300, retryMaxTokens: 2000 } } }, 'hi');
    assert.deepEqual(f.requests.map((r) => r.body.max_tokens), [300, 2000]);
    assert.deepEqual([res.status, res.output, res.turns], ['completed', 'ok', 2]);
    assert.equal(f.requests[1]!.body.messages.length, 1, 'the discarded answer is not sent back');
    const twice = fakeFetch([thinkingOnly, thinkingOnly]);
    const b = thinkingAgent(twice);
    const stopped = await run({ ...b, model: { ...b.model, params: { maxTokens: 300, retryMaxTokens: 600 } } }, 'hi');
    assert.equal(twice.requests.length, 2);
    assert.deepEqual([stopped.status, stopped.reason], ['stopped', 'max_tokens']);
  });
});
