import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { mockProvider, otlpMetricsSink, otlpSink, run, type RunEvent } from '../src/index.ts';

async function receiver() {
  const got: Array<{ url: string; body: any }> = [];
  const server = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      got.push({ url: req.url!, body: JSON.parse(data) });
      res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { got, endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

const attr = (span: any, key: string) => span.attributes.find((a: any) => a.key === key)?.value;
const str = (v: any) => v?.stringValue;

const lookup = { name: 'lookup', description: 'l', risk: 'read' as const, layer: 'knowledge' as const, schema: { type: 'object' }, run: () => 'SECRET-RESULT' };
const noop = { name: 'noop', description: 'n', risk: 'read' as const, schema: { type: 'object' }, run: () => 'done' };
const agent = () => ({
  name: 'traced',
  model: { provider: mockProvider([{ toolCalls: [{ name: 'lookup', args: { q: 'SECRET-ARG' } }, { name: 'noop' }] }, { text: 'ok' }]), model: 'm' },
  tools: [lookup, noop],
});
const inject = (sink: { onEvent(ev: RunEvent): void }, runId: string, type: string, data: unknown) =>
  sink.onEvent({ runId, seq: 0, ts: 0, type, data } as unknown as RunEvent);

describe('otlp sink layers', () => {
  it('tags every span with agent.layer and the end user, without leaking content or tokens', async () => {
    const rx = await receiver();
    const sink = otlpSink({ endpoint: rx.endpoint });
    await run(agent(), 'go', { sinks: [sink], identity: { subject: 'alice', kind: 'user', token: 'TOKEN-XYZ' } });
    await sink.close!();
    rx.close();
    const spans = rx.got.flatMap((b) => b.body.resourceSpans[0].scopeSpans[0].spans);
    const layer = (name: string) => str(attr(spans.find((s: any) => s.name === name), 'agent.layer'));
    assert.equal(layer('invoke_agent traced'), 'harness');
    assert.equal(layer('chat m'), 'llm');
    assert.equal(layer('execute_tool lookup'), 'knowledge');
    assert.equal(layer('execute_tool noop'), 'tool');
    assert.ok(spans.every((s: any) => str(attr(s, 'agent.layer'))));
    assert.equal(str(attr(spans.find((s: any) => s.name === 'invoke_agent traced'), 'enduser.id')), 'alice');
    const raw = JSON.stringify(rx.got);
    for (const secret of ['TOKEN-XYZ', 'SECRET-ARG', 'SECRET-RESULT']) assert.ok(!raw.includes(secret), secret);
  });

  it('keeps content only with captureContent', async () => {
    const rx = await receiver();
    const sink = otlpSink({ endpoint: rx.endpoint, captureContent: true });
    await run(agent(), 'go', { sinks: [sink] });
    await sink.close!();
    rx.close();
    assert.ok(JSON.stringify(rx.got).includes('SECRET-RESULT'));
  });

  it('records tool decisions and mapped extra events as span events, ignoring unknown types', async () => {
    const rx = await receiver();
    const sink = otlpSink({ endpoint: rx.endpoint, eventLayers: { custom_event: 'eval' } });
    await run(agent(), 'go', { sinks: [sink] });
    inject(sink, 'r-x', 'run_start', { agent: 'x', resumed: false });
    inject(sink, 'r-x', 'guardrail', { action: 'block', stage: 'input', reason: 'contains SECRET-PII' });
    inject(sink, 'r-x', 'custom_event', { count: 2 });
    inject(sink, 'r-x', 'totally_unknown', { a: 1 });
    inject(sink, 'r-x', 'run_end', { status: 'completed', usage: { inputTokens: 0, outputTokens: 0 }, turns: 0, costUsd: 0 });
    await sink.close!();
    rx.close();
    const spans = rx.got.flatMap((b) => b.body.resourceSpans[0].scopeSpans[0].spans);
    const events = (name: string) => spans.find((s: any) => s.name === name).events ?? [];
    const decision = events('invoke_agent traced').find((e: any) => e.name === 'tool_decision');
    assert.equal(str(attr(decision, 'agent.layer')), 'identity');
    assert.equal(attr(decision, 'allowed').boolValue, true);
    const x = events('invoke_agent x');
    assert.deepEqual(x.map((e: any) => e.name), ['guardrail', 'custom_event']);
    assert.equal(str(attr(x[0], 'agent.layer')), 'guardrail');
    assert.equal(str(attr(x[0], 'action')), 'block');
    assert.equal(attr(x[0], 'reason'), undefined);
    assert.equal(str(attr(x[1], 'agent.layer')), 'eval');
  });
});

describe('knowledge span events', () => {
  it('records knowledge_retrieval counts, and its query and error only with captureContent', async () => {
    for (const captureContent of [false, true]) {
      const rx = await receiver();
      const sink = otlpSink({ endpoint: rx.endpoint, captureContent });
      inject(sink, 'r-k', 'run_start', { agent: 'k', resumed: false });
      inject(sink, 'r-k', 'knowledge_retrieval', { source: 'docs', query: 'SECRET-QUERY', passages: 0, ids: [], durationMs: 12, error: 'timed out' });
      inject(sink, 'r-k', 'run_end', { status: 'completed', usage: { inputTokens: 0, outputTokens: 0 }, turns: 0, costUsd: 0 });
      await sink.close!();
      rx.close();
      const spans = rx.got.flatMap((b) => b.body.resourceSpans[0].scopeSpans[0].spans);
      const ev = spans.find((s: any) => s.name === 'invoke_agent k').events[0];
      assert.equal(str(attr(ev, 'agent.layer')), 'knowledge');
      assert.equal(str(attr(ev, 'source')), 'docs');
      assert.equal(attr(ev, 'passages').intValue, '0');
      assert.equal(attr(ev, 'error') !== undefined, captureContent);
      assert.equal(JSON.stringify(rx.got).includes('SECRET-QUERY'), captureContent);
    }
  });
});

describe('otlp metrics', () => {
  it('exports cumulative histograms and counters to /v1/metrics', async () => {
    const rx = await receiver();
    const sink = otlpMetricsSink({ endpoint: `${rx.endpoint}/v1/traces`, serviceName: 'svc' });
    await run(agent(), 'go', { sinks: [sink] });
    inject(sink, 'r', 'guardrail', { action: 'redact' });
    await sink.close!();
    rx.close();
    assert.ok(rx.got.every((g) => g.url === '/v1/metrics'));
    const rm = rx.got.at(-1)!.body.resourceMetrics[0];
    assert.equal(str(rm.resource.attributes[0].value), 'svc');
    const m: Record<string, any> = Object.fromEntries(rm.scopeMetrics[0].metrics.map((x: any) => [x.name, x]));
    assert.deepEqual(Object.keys(m).sort(), ['agent.guardrail.actions', 'agent.policy.decisions', 'agent.runs', 'agent.tool.calls', 'gen_ai.client.operation.duration', 'gen_ai.client.token.usage']);
    const tok = m['gen_ai.client.token.usage']!.histogram;
    assert.equal(tok.aggregationTemporality, 2);
    assert.equal(m['gen_ai.client.token.usage']!.unit, '{token}');
    assert.deepEqual(tok.dataPoints.map((p: any) => str(attr(p, 'gen_ai.token.type'))).sort(), ['input', 'output']);
    const p = tok.dataPoints[0];
    assert.equal(p.count, '2');
    assert.equal(p.bucketCounts.length, p.explicitBounds.length + 1);
    assert.equal(p.bucketCounts.reduce((a: number, b: string) => a + Number(b), 0), 2);
    assert.equal(m['gen_ai.client.operation.duration']!.unit, 's');
    const calls = m['agent.tool.calls']!.sum;
    assert.equal(calls.isMonotonic, true);
    const byTool = Object.fromEntries(calls.dataPoints.map((d: any) => [str(attr(d, 'tool')), d]));
    assert.equal(str(attr(byTool.lookup, 'layer')), 'knowledge');
    assert.equal(str(attr(byTool.noop, 'layer')), 'tool');
    assert.equal(attr(byTool.noop, 'error').boolValue, false);
    assert.equal(m['agent.runs']!.sum.dataPoints[0].asDouble, 1);
    assert.equal(str(attr(m['agent.runs']!.sum.dataPoints[0], 'status')), 'completed');
    assert.equal(m['agent.policy.decisions']!.sum.dataPoints[0].asDouble, 2);
    assert.equal(str(attr(m['agent.guardrail.actions']!.sum.dataPoints[0], 'action')), 'redact');
  });

  it('flushes on run_end and through the otlp sink metrics option', async () => {
    const rx = await receiver();
    const sink = otlpSink({ endpoint: rx.endpoint, metrics: true, intervalMs: 60_000 });
    await run(agent(), 'go', { sinks: [sink] });
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(rx.got.some((g) => g.url === '/v1/metrics'), 'metrics flushed on run_end');
    assert.ok(!rx.got.some((g) => g.url === '/v1/traces'), 'spans wait for the interval');
    await sink.close!();
    rx.close();
    assert.ok(rx.got.some((g) => g.url === '/v1/traces'));
  });
});
