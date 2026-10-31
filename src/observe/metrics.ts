import type { RunEvent, Sink } from '../types.ts';
import { errorMessage } from '../util.ts';
import { type Attrs, nowNanos, toAttributes } from './otlp-json.ts';

export interface OtlpMetricsOptions {
  /** Collector base URL (e.g. http://localhost:4318) or the full `/v1/metrics` URL. */
  endpoint: string;
  headers?: Record<string, string>;
  serviceName?: string;
  /** Export interval (default 10000 ms). Metrics are also sent on every `run_end` and on close. */
  intervalMs?: number;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

// Bucket boundaries recommended by the OpenTelemetry GenAI semantic conventions.
const TOKEN_BOUNDS = [1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864];
const DURATION_BOUNDS = [0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92];

/** AggregationTemporality: CUMULATIVE. Totals only grow, so a lost export is healed by the next one. */
const CUMULATIVE = 2;

interface Histogram { count: number; sum: number; min: number; max: number; buckets: number[] }
interface Instrument {
  name: string;
  unit: string;
  description: string;
  /** Present for histograms; counters have no bounds. */
  bounds?: number[];
  series: Map<string, { attrs: Attrs; value: number; histogram?: Histogram }>;
}

const instrument = (name: string, unit: string, description: string, bounds?: number[]): Instrument => ({ name, unit, description, bounds, series: new Map() });

/**
 * Aggregates run events into OTLP metrics (OTLP/HTTP JSON to `/v1/metrics`, no SDK, cumulative temporality):
 * `gen_ai.client.token.usage` and `gen_ai.client.operation.duration` (histograms, GenAI semantic conventions) and the
 * counters `agent.tool.calls`, `agent.cost.usd`, `agent.policy.decisions`, `agent.guardrail.actions`, `agent.runs`.
 * Never records message content, tool arguments or tokens.
 */
export function otlpMetricsSink(opts: OtlpMetricsOptions): Sink {
  const url = `${opts.endpoint.replace(/\/+$/, '').replace(/\/v1\/(traces|metrics)$/, '')}/v1/metrics`;
  const post = opts.fetch ?? fetch;
  const startNanos = nowNanos();
  const tokens = instrument('gen_ai.client.token.usage', '{token}', 'Input and output tokens used per model call', TOKEN_BOUNDS);
  const duration = instrument('gen_ai.client.operation.duration', 's', 'Duration of model calls', DURATION_BOUNDS);
  const toolCalls = instrument('agent.tool.calls', '{call}', 'Tool calls, including denied ones');
  const cost = instrument('agent.cost.usd', 'USD', 'Model cost');
  const decisions = instrument('agent.policy.decisions', '{decision}', 'Tool policy decisions');
  const guardrails = instrument('agent.guardrail.actions', '{action}', 'Guardrail verdicts by action');
  const runs = instrument('agent.runs', '{run}', 'Finished runs by status');
  const all = [tokens, duration, toolCalls, cost, decisions, guardrails, runs];
  let dirty = false;
  let warned = false;
  let chain: Promise<void> = Promise.resolve();

  const point = (inst: Instrument, attrs: Attrs) => {
    const key = JSON.stringify(Object.entries(attrs).sort(([a], [b]) => (a < b ? -1 : 1)));
    let p = inst.series.get(key);
    if (!p) inst.series.set(key, (p = { attrs, value: 0, ...(inst.bounds && { histogram: { count: 0, sum: 0, min: Infinity, max: -Infinity, buckets: new Array(inst.bounds.length + 1).fill(0) } }) }));
    dirty = true;
    return p;
  };
  const add = (inst: Instrument, attrs: Attrs, n = 1) => void (point(inst, attrs).value += n);
  const record = (inst: Instrument, attrs: Attrs, v: number) => {
    const h = point(inst, attrs).histogram!;
    h.count++;
    h.sum += v;
    h.min = Math.min(h.min, v);
    h.max = Math.max(h.max, v);
    const i = inst.bounds!.findIndex((b) => v <= b);
    h.buckets[i < 0 ? inst.bounds!.length : i]!++;
  };

  const body = () => {
    const now = nowNanos();
    const metrics = all
      .filter((inst) => inst.series.size)
      .map((inst) => {
        const dataPoints = [...inst.series.values()].map((p) => {
          const base = { attributes: toAttributes(p.attrs), startTimeUnixNano: startNanos, timeUnixNano: now };
          return p.histogram
            ? { ...base, count: String(p.histogram.count), sum: p.histogram.sum, min: p.histogram.min, max: p.histogram.max, bucketCounts: p.histogram.buckets.map(String), explicitBounds: inst.bounds }
            : { ...base, asDouble: p.value };
        });
        const head = { name: inst.name, description: inst.description, unit: inst.unit };
        return inst.bounds
          ? { ...head, histogram: { aggregationTemporality: CUMULATIVE, dataPoints } }
          : { ...head, sum: { aggregationTemporality: CUMULATIVE, isMonotonic: true, dataPoints } };
      });
    return {
      resourceMetrics: [{
        resource: { attributes: toAttributes({ 'service.name': opts.serviceName ?? 'reinloop' }) },
        scopeMetrics: [{ scope: { name: 'reinloop' }, metrics }],
      }],
    };
  };

  const send = async () => {
    if (!dirty) return;
    dirty = false;
    try {
      const res = await post(url, { method: 'POST', headers: { 'content-type': 'application/json', ...opts.headers }, body: JSON.stringify(body()) });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
    } catch (err) {
      dirty = true;
      if (!warned) process.emitWarning(`OTLP metrics export to ${url} failed: ${errorMessage(err)}`);
      warned = true;
    }
  };
  const flush = () => (chain = chain.then(send));

  const timer = setInterval(() => void flush(), opts.intervalMs ?? 10_000);
  timer.unref();

  return {
    name: 'otlp-metrics',
    onEvent(ev: RunEvent) {
      const type: string = ev.type;
      switch (ev.type) {
        case 'model_response': {
          const attrs = { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': ev.data.model };
          record(tokens, { ...attrs, 'gen_ai.token.type': 'input' }, ev.data.usage.inputTokens);
          record(tokens, { ...attrs, 'gen_ai.token.type': 'output' }, ev.data.usage.outputTokens);
          record(duration, attrs, ev.data.latencyMs / 1000);
          if (ev.data.costUsd) add(cost, { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': ev.data.model }, ev.data.costUsd);
          break;
        }
        case 'compaction':
          if (ev.data.costUsd) add(cost, { 'gen_ai.operation.name': 'compaction' }, ev.data.costUsd);
          break;
        case 'tool_result':
          add(toolCalls, { tool: ev.data.name, error: ev.data.isError, layer: ev.data.layer ?? 'tool' });
          break;
        case 'tool_decision':
          add(decisions, { allowed: ev.data.allowed });
          break;
        case 'run_end':
          add(runs, { status: ev.data.status });
          void flush();
          break;
        default:
          if (type === 'guardrail') {
            const data = ev.data as unknown as Record<string, unknown>;
            add(guardrails, { action: typeof data.action === 'string' ? data.action : 'unknown' });
          }
      }
    },
    async close() {
      clearInterval(timer);
      await flush();
    },
  };
}
