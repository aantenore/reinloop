import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { anthropic, costOf, createRuntime, hostedTool, openaiCompatible, pricingFor, run, stream, type ModelRequest, type RunEvent } from '../src/index.ts';
import { fakeFetch, json, makeAgent, sse } from './helpers.ts';

const signal = new AbortController().signal;
const fixture = JSON.parse(readFileSync(new URL('./fixtures/anthropic-web-search.json', import.meta.url), 'utf8'));
const webSearch = hostedTool({ provider: 'anthropic', type: 'web_search_20250305', params: { max_uses: 5, allowed_domains: ['example.com'] } });
const spec = { name: webSearch.name, description: webSearch.description, schema: webSearch.schema, hosted: webSearch.hosted };
const req = (extra: Partial<ModelRequest> = {}): ModelRequest => ({ model: 'claude-haiku-5-5', messages: [{ role: 'user', parts: [{ type: 'text', text: 'q' }] }], tools: [spec], ...extra });

describe('hostedTool', () => {
  it('derives name, risk and use limit from the type', () => {
    assert.equal(webSearch.name, 'web_search');
    assert.equal(webSearch.risk, 'read');
    assert.equal(webSearch.hosted?.limitParam, 'max_uses');
    const code = hostedTool({ provider: 'anthropic', type: 'code_execution_20260521' });
    assert.equal(code.name, 'code_execution');
    assert.equal(code.risk, 'exec');
    assert.equal(code.hosted?.limitParam, undefined);
  });
});

describe('anthropic hosted tools', () => {
  it('sends hosted tools verbatim and maps server tool blocks, citations and usage', async () => {
    const f = fakeFetch([json(fixture)]);
    const p = anthropic({ apiKey: 'k', fetch: f.impl });
    const res = await p.generate(req(), { signal });
    assert.deepEqual(f.requests[0]!.body.tools, [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5, allowed_domains: ['example.com'] }]);
    const [thinking, call, result, text, fetchCall, fetchResult] = res.message.parts as any[];
    assert.equal(thinking.type, 'thinking');
    assert.deepEqual(call, { type: 'hosted_call', id: 'srvtoolu_1', name: 'web_search', input: { query: 'MCP server security' } });
    assert.equal(result.type, 'hosted_result');
    assert.equal(result.blockType, 'web_search_tool_result');
    assert.equal(result.isError, false);
    assert.equal(result.sources.length, 2);
    assert.match(result.summary, /2 result\(s\): MCP security guide <https:\/\/example.com\/a>/);
    assert.equal(text.citations[0].cited_text, 'Always scan MCP servers.');
    assert.equal(fetchCall.name, 'web_fetch');
    assert.equal(fetchResult.isError, true);
    assert.equal(fetchResult.summary, 'error: url_not_accessible');
    assert.deepEqual(res.usage.serverToolUse, { webSearchRequests: 1, webFetchRequests: 1 });
  });

  it('echoes hosted blocks and citations unchanged in the next request', async () => {
    const f = fakeFetch([json(fixture), json({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: {} })]);
    const p = anthropic({ apiKey: 'k', fetch: f.impl });
    const first = await p.generate(req(), { signal });
    await p.generate(req({ messages: [...req().messages, first.message, { role: 'user', parts: [{ type: 'text', text: 'more' }] }] }), { signal });
    const assistant = f.requests[1]!.body.messages[1];
    assert.equal(assistant.role, 'assistant');
    assert.deepEqual(assistant.content, fixture.content);
  });

  it('maps streamed server tool blocks and citation deltas', async () => {
    const f = fakeFetch([
      sse([
        { data: { type: 'message_start', message: { model: 'claude-haiku-5-5', usage: { input_tokens: 10 } } } },
        { data: { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 's1', name: 'web_search', input: {} } } },
        { data: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"x"}' } } },
        { data: { type: 'content_block_start', index: 1, content_block: fixture.content[2] } },
        { data: { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '', citations: null } } },
        { data: { type: 'content_block_delta', index: 2, delta: { type: 'citations_delta', citation: fixture.content[3].citations[0] } } },
        { data: { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Answer' } } },
        { data: { type: 'message_delta', delta: { stop_reason: 'pause_turn' }, usage: { output_tokens: 5, server_tool_use: { web_search_requests: 1 } } } },
        { data: { type: 'message_stop' } },
      ]),
    ]);
    const res = await anthropic({ apiKey: 'k', fetch: f.impl, stream: true }).generate(req(), { signal });
    const [call, result, text] = res.message.parts as any[];
    assert.deepEqual(call.input, { query: 'x' });
    assert.equal(result.callId, 'srvtoolu_1');
    assert.equal(text.citations.length, 1);
    assert.equal(res.stopReason, 'pause_turn');
    assert.deepEqual(res.usage.serverToolUse, { webSearchRequests: 1 });
  });

  it('adds beta flags and rejects tools for another provider', async () => {
    const f = fakeFetch([json(fixture)]);
    const beta = hostedTool({ provider: 'anthropic', type: 'web_fetch_20250910', beta: 'web-fetch-2025-09-10' });
    await anthropic({ apiKey: 'k', fetch: f.impl, headers: { 'anthropic-beta': 'other' } }).generate(
      req({ tools: [{ name: beta.name, description: '', schema: {}, hosted: beta.hosted }] }),
      { signal },
    );
    assert.equal(f.requests[0]!.headers['anthropic-beta'], 'other,web-fetch-2025-09-10');
    const foreign = { ...spec, hosted: { provider: 'openai', type: 'web_search' } };
    await assert.rejects(anthropic({ apiKey: 'k', fetch: f.impl }).generate(req({ tools: [foreign] }), { signal }), /targets provider "openai"/);
    await assert.rejects(openaiCompatible({ fetch: f.impl }).generate(req(), { signal }), /not supported by Chat Completions/);
  });
});

describe('hosted tools in the loop', () => {
  const hostedTurn = {
    parts: [
      { type: 'hosted_call' as const, id: 's1', name: 'web_search', input: { query: 'q' } },
      { type: 'hosted_result' as const, callId: 's1', name: 'web_search', blockType: 'web_search_tool_result', content: [], summary: '0 result(s)', sources: [] },
    ],
    text: 'found it',
    usage: { inputTokens: 1_000_000, outputTokens: 0, serverToolUse: { webSearchRequests: 3 } },
  };

  it('emits hosted events, keeps parts in history, counts tool calls and prices searches', async () => {
    const a = makeAgent([hostedTurn], { tools: [webSearch], model: undefined as any });
    a.model = { provider: a.provider, model: 'claude-haiku-5-5', pricing: pricingFor('claude-haiku-5-5') };
    const events: RunEvent[] = [];
    const h = stream(a, 'search');
    for await (const ev of h) events.push(ev);
    const res = await h.result;
    assert.equal(res.status, 'completed');
    assert.ok(events.some((e) => e.type === 'hosted_tool_start' && e.data.name === 'web_search'));
    assert.ok(events.some((e) => e.type === 'hosted_tool_result' && e.data.summary === '0 result(s)'));
    assert.ok(events.some((e) => e.type === 'tool_decision' && e.data.name === 'web_search' && e.data.allowed));
    assert.ok(res.messages[1]!.parts.some((p) => p.type === 'hosted_result'));
    assert.equal(res.costUsd, 0.1 + 3 * 0.01);
    assert.equal(a.provider.requests[0]!.tools[0]!.hosted?.type, 'web_search_20250305');
  });

  it('caps max_uses to the remaining maxToolCalls budget', async () => {
    const a = makeAgent([{ text: 'ok' }], { tools: [webSearch], budget: { maxToolCalls: 2 } });
    await run(a, 'go');
    assert.equal(a.provider.requests[0]!.tools[0]!.hosted?.params?.max_uses, 2);
  });

  it('stops on maxToolCalls after hosted calls', async () => {
    const a = makeAgent([{ ...hostedTurn, toolCalls: [{ name: 'noop' }] }], { tools: [webSearch], budget: { maxToolCalls: 1 } });
    const res = await run(a, 'go');
    assert.equal(res.status, 'stopped');
    assert.equal(res.reason, 'budget:maxToolCalls');
  });

  it('resumes after pause_turn without adding a user message', async () => {
    const a = makeAgent([{ ...hostedTurn, text: undefined, stopReason: 'pause_turn' }, { text: 'done' }], { tools: [webSearch] });
    const res = await run(a, 'go');
    assert.equal(res.output, 'done');
    assert.equal(a.provider.requests[1]!.messages.at(-1)!.role, 'assistant');
  });

  it('denies code execution without an approver, allows it with one or by policy', async () => {
    const code = hostedTool({ provider: 'anthropic', type: 'code_execution_20260521' });
    const denied = makeAgent([{ text: 'ok' }], { tools: [code] });
    const events: RunEvent[] = [];
    const h = stream(denied, 'go');
    for await (const ev of h) events.push(ev);
    assert.equal(denied.provider.requests[0]!.tools.length, 0);
    const decision = events.find((e) => e.type === 'tool_decision');
    assert.ok(decision && decision.type === 'tool_decision' && !decision.data.allowed && /no approver/.test(decision.data.reason));

    const approved = makeAgent([{ text: 'ok' }], { tools: [code] });
    await run(approved, 'go', { approve: () => true });
    assert.equal(approved.provider.requests[0]!.tools[0]!.name, 'code_execution');

    const byPolicy = makeAgent([{ text: 'ok' }], { tools: [code], policy: { rules: [{ match: 'code_execution', action: 'allow' }] } });
    await run(byPolicy, 'go');
    assert.equal(byPolicy.provider.requests[0]!.tools.length, 1);
  });
});

describe('server tool pricing', () => {
  it('prices server tool use and merges overrides', () => {
    const usage = { inputTokens: 0, outputTokens: 0, serverToolUse: { webSearchRequests: 10, webFetchRequests: 4 } };
    assert.equal(costOf(pricingFor('claude-sonnet-5-5'), usage), 0.1);
    const custom = pricingFor('claude-sonnet-5-5', { 'claude-sonnet-5-5': { serverToolUsd: { webFetchRequests: 0.5 } } });
    assert.equal(custom?.serverToolUsd?.webSearchRequests, 0.01);
    assert.equal(costOf(custom, usage), 0.1 + 2);
  });
});

describe('hosted tools in config', () => {
  it('resolves hostedTools by name with precedence over built-ins', async () => {
    const rt = await createRuntime({
      hostedTools: { web_search: { provider: 'anthropic', type: 'web_search_20260209', params: { max_uses: 3 } } },
      agents: { a: { model: 'mock/x', tools: ['web_search'] } },
    });
    const a = (await rt.agent('a')) as any;
    assert.equal(a.tools[0].hosted.type, 'web_search_20260209');
    assert.equal(a.tools[0].risk, 'read');
  });
});
