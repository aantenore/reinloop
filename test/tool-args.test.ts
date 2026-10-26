import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { anthropic, collectSink, run, type Agent } from '../src/index.ts';
import { parseToolJson } from '../src/providers/http.ts';
import { echoTool, fakeFetch, sse } from './helpers.ts';

/** One streamed Anthropic turn calling `echo` with the given partial_json chunks. */
const toolTurn = (chunks: string[], stop = 'tool_use') =>
  sse([
    { event: 'message_start', data: { type: 'message_start', message: { model: 'claude-haiku-5-5', usage: { input_tokens: 5, output_tokens: 1 } } } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: 'echo', input: {} } } },
    ...chunks.map((partial_json) => ({ event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json } } })),
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 8 } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);
const textTurn = (text: string) =>
  sse([
    { event: 'message_start', data: { type: 'message_start', message: { model: 'claude-haiku-5-5', usage: { input_tokens: 5, output_tokens: 1 } } } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);

const agentWith = (fetchImpl: any, echo = echoTool()): Agent & { echo: typeof echo } => ({
  name: 't',
  model: { provider: anthropic({ fetch: fetchImpl, stream: true, apiKey: 'test' }), model: 'claude-haiku-5-5' },
  tools: [echo],
  echo,
});

describe('parseToolJson', () => {
  it('repairs syntax damage and refuses cut-off values', () => {
    assert.deepEqual(parseToolJson('{"text":"a"}'), { value: { text: 'a' } });
    assert.deepEqual(parseToolJson(''), { value: {} });
    const fixed: Array<[string, unknown]> = [
      ['{"text":"a",}', { text: 'a' }],
      ['{"a":[1,2,],}', { a: [1, 2] }],
      ['{"text":"a","n":', { text: 'a' }],
      ['{"text":"a","n"', { text: 'a' }],
      ['{"text":"a","n', { text: 'a' }],
      ['{"text":"a","o":{"k":"v"', { text: 'a', o: { k: 'v' } }],
      ['{"text":"}{","l":["x"', { text: '}{', l: ['x'] }],
    ];
    for (const [raw, value] of fixed) {
      const out = parseToolJson(raw);
      assert.ok('value' in out && out.repaired, raw);
      assert.deepEqual((out as any).value, value, raw);
    }
    for (const raw of ['{"text":"a" "n":1}', '{"text":"cut of', '{"n":12', '{"ok":tru', '{"a":1}}']) assert.ok('error' in parseToolJson(raw), raw);
    assert.match((parseToolJson('{"text":"cut') as any).error, /cut off/);
  });
});

describe('malformed streamed tool arguments (anthropic)', () => {
  it('answers unrepairable arguments with a tool error and lets the model retry', async () => {
    const f = fakeFetch([toolTurn(['{"text":"a"', ' "b":1}']), toolTurn(['{"text":', '"retry"}']), textTurn('done')]);
    const agent = agentWith(f.impl);
    const sink = collectSink();
    const res = await run(agent, 'go', { sinks: [sink] });
    assert.equal(res.status, 'completed');
    assert.equal(res.output, 'done');
    assert.equal(agent.echo.calls, 1, 'only the valid retry runs');
    const results = sink.events.filter((e) => e.type === 'tool_result').map((e: any) => e.data);
    assert.equal(results[0].isError, true);
    assert.match(results[0].content, /^Invalid JSON arguments for tool echo: Expected ',' or '}' after property value.*Please retry/);
    assert.equal(results[1].content, 'echoed:retry');
    const invalid = sink.events.filter((e) => e.type === 'tool_args_invalid').map((e: any) => e.data);
    assert.deepEqual(invalid.map((d) => [d.name, d.repaired]), [['echo', false]]);
    assert.equal(res.usage.toolArgsInvalid, 1);
    // The bad call is echoed back with an object input so the next request stays valid.
    const second = f.requests[1]!.body.messages;
    const toolUse = second.flatMap((m: any) => (Array.isArray(m.content) ? m.content : [])).find((b: any) => b.type === 'tool_use');
    assert.deepEqual(toolUse.input, {});
  });

  it('runs the call with repaired arguments and records the repair', async () => {
    const f = fakeFetch([toolTurn(['{"text":"fixed",', '}']), textTurn('ok')]);
    const agent = agentWith(f.impl);
    const sink = collectSink();
    const res = await run(agent, 'go', { sinks: [sink] });
    assert.equal(res.status, 'completed');
    assert.equal(agent.echo.calls, 1);
    assert.equal(sink.events.find((e) => e.type === 'tool_result')!.data.content, 'echoed:fixed');
    const ev = sink.events.find((e) => e.type === 'tool_args_invalid')!;
    assert.equal((ev.data as any).repaired, true);
    assert.equal(res.usage.toolArgsInvalid, 1);
  });

  it('does not run a call whose string argument was cut at max_tokens', async () => {
    const f = fakeFetch([toolTurn(['{"text":"half a sent'], 'max_tokens'), textTurn('gave up')]);
    const agent = agentWith(f.impl);
    const res = await run(agent, 'go');
    assert.equal(agent.echo.calls, 0);
    assert.notEqual(res.status, 'failed', res.reason);
  });
});
