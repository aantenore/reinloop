import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { anthropic, costOf, pricingFor, type ModelRequest } from '../src/index.ts';
import { fakeFetch, json } from './helpers.ts';

const signal = new AbortController().signal;
const long = 'policy '.repeat(1200); // ~2100 estimated tokens: above the 1024-token minimum
const ok = (usage: Record<string, unknown> = {}) => json({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1, ...usage } });
const req = (extra: Partial<ModelRequest> = {}): ModelRequest => ({
  model: 'claude-sonnet-5-5',
  instructions: long,
  tools: [{ name: 'echo', description: long, schema: { type: 'object' } }],
  messages: [
    { role: 'user', parts: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', parts: [{ type: 'thinking', text: '', signature: 's' }, { type: 'tool_call', id: 'c1', name: 'echo', args: {} }] },
    { role: 'tool', parts: [{ type: 'tool_result', callId: 'c1', name: 'echo', content: 'done' }] },
  ],
  ...extra,
});
const marks = (body: any) => JSON.stringify(body).match(/"cache_control"/g)?.length ?? 0;

describe('anthropic prompt caching', () => {
  it('puts breakpoints on tools, system and the latest message by default', async () => {
    const f = fakeFetch([ok()]);
    await anthropic({ apiKey: 'k', fetch: f.impl }).generate(req(), { signal });
    const body = f.requests[0]!.body;
    assert.deepEqual(body.tools[0].cache_control, { type: 'ephemeral' });
    assert.deepEqual(body.system[0].cache_control, { type: 'ephemeral' });
    assert.deepEqual(body.messages.at(-1).content.at(-1).cache_control, { type: 'ephemeral' });
    assert.ok(marks(body) <= 4);
  });

  it('uses the 1h ttl from params and can be turned off per agent', async () => {
    const f = fakeFetch([ok(), ok()]);
    const p = anthropic({ apiKey: 'k', fetch: f.impl });
    await p.generate(req({ params: { cacheTtl: '1h' } }), { signal });
    assert.deepEqual(f.requests[0]!.body.system[0].cache_control, { type: 'ephemeral', ttl: '1h' });
    await p.generate(req({ params: { cache: false } }), { signal });
    assert.equal(marks(f.requests[1]!.body), 0);
    assert.equal(typeof f.requests[1]!.body.system, 'string');
  });

  it('skips breakpoints whose prefix is below the minimum and never marks thinking blocks', async () => {
    const f = fakeFetch([ok(), ok()]);
    const p = anthropic({ apiKey: 'k', fetch: f.impl });
    await p.generate(req({ instructions: 'short', tools: [] }), { signal });
    assert.equal(marks(f.requests[0]!.body), 0);
    const paused: ModelRequest = req({ messages: [{ role: 'user', parts: [{ type: 'text', text: long }] }, { role: 'assistant', parts: [{ type: 'text', text: 'partial' }, { type: 'thinking', text: '', signature: 's' }] }] });
    await p.generate(paused, { signal });
    const last = f.requests[1]!.body.messages.at(-1).content;
    assert.equal(last.find((b: any) => b.type === 'thinking').cache_control, undefined);
    assert.ok(last.find((b: any) => b.type === 'text').cache_control);
  });

  it('reads 5m/1h cache writes and reads into usage', async () => {
    const f = fakeFetch([ok({ cache_read_input_tokens: 500, cache_creation_input_tokens: 300, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 } })]);
    const res = await anthropic({ apiKey: 'k', fetch: f.impl }).generate(req(), { signal });
    assert.deepEqual(res.usage, { inputTokens: 801, outputTokens: 1, cacheReadTokens: 500, cacheWriteTokens: 300, cacheWrite1hTokens: 200 });
  });

  it('prices cache writes and reads with the table multipliers', () => {
    const price = pricingFor('claude-sonnet-5-5')!; // $2 in, $10 out, $0.20 read, writes 1.25x / 2x
    const usage = { inputTokens: 1_801_000, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 800_000, cacheWrite1hTokens: 300_000 };
    const expected = 0.001 * 2 + 1 * 0.2 + 0.5 * 2 * 1.25 + 0.3 * 2 * 2;
    assert.ok(Math.abs(costOf(price, usage) - expected) < 1e-9);
    assert.equal(costOf({ inputPerMTok: 1, outputPerMTok: 1 }, { inputTokens: 1_000_000, outputTokens: 0, cacheWriteTokens: 1_000_000 }), 1, 'no multiplier: input price');
  });
});
