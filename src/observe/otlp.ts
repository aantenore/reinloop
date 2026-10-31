import { randomBytes } from 'node:crypto';
import type { Layer, Sink } from '../types.ts';
import { type OtelSpan, type OtelTracer, otelSink } from './otel.ts';
import { otlpMetricsSink, TELEMETRY_LIMITS } from './metrics.ts';
import { type Attrs, assertPlainEndpoint, ExportStatusError, exportFailure, exportSignal, nowNanos, toAttributes } from './otlp-json.ts';

export interface OtlpOptions {
  /** Collector base URL (e.g. http://localhost:4318) or the full `/v1/traces` URL. */
  endpoint: string;
  headers?: Record<string, string>;
  serviceName?: string;
  captureContent?: boolean;
  /** Export interval for finished spans (default 2000 ms; metrics too unless `metricsIntervalMs` is set). Remaining spans are sent on close. */
  intervalMs?: number;
  /** Export interval for metrics (default: `intervalMs` when set, else 10000 ms). */
  metricsIntervalMs?: number;
  /** Time limit of one export request in ms (default 10000; Infinity: none). A timed-out export is dropped with a warning, never raised. */
  exportTimeoutMs?: number;
  /** Also export OTLP metrics (`/v1/metrics`, see `otlpMetricsSink`) from the same events. */
  metrics?: boolean;
  /** Extra or overriding event type → layer entries for events recorded as span events. */
  eventLayers?: Record<string, Layer>;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

interface Recorded {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano?: string;
  attributes: Attrs;
  status?: { code: number; message?: string };
  events?: Array<{ timeUnixNano: string; name: string; attributes: Attrs }>;
}

/**
 * Exports run events as OpenTelemetry spans over OTLP/HTTP JSON, with no SDK. Works with any collector and
 * with backends that accept OTLP JSON directly; put an OpenTelemetry Collector in front of protobuf-only ones.
 */
export function otlpSink(opts: OtlpOptions): Sink {
  assertPlainEndpoint(opts.endpoint, 'otlpSink');
  const url = /\/v1\/traces\/?$/.test(opts.endpoint) ? opts.endpoint : `${opts.endpoint.replace(/\/+$/, '')}/v1/traces`;
  const post = opts.fetch ?? fetch;
  const exportTimeoutMs = opts.exportTimeoutMs ?? TELEMETRY_LIMITS['otlp.exportTimeoutMs'].default;
  let pending: Recorded[] = [];
  let warned = false;

  const tracer: OtelTracer = {
    startSpan(name, options, context) {
      const parent = context as (OtelSpan & { record: Recorded }) | undefined;
      const record: Recorded = {
        traceId: parent?.record.traceId ?? randomBytes(16).toString('hex'),
        spanId: randomBytes(8).toString('hex'),
        parentSpanId: parent?.record.spanId,
        name,
        kind: (options?.kind ?? 0) + 1, // API SpanKind (INTERNAL=0, CLIENT=2) → OTLP (INTERNAL=1, CLIENT=3)
        startTimeUnixNano: nowNanos(),
        attributes: { ...options?.attributes },
      };
      return {
        record,
        setAttribute: (k: string, v: string | number | boolean) => void (record.attributes[k] = v),
        setStatus: (s: { code: number; message?: string }) => void (record.status = s),
        addEvent: (name: string, attributes: Attrs = {}) =>
          void (record.events ??= []).push({ timeUnixNano: nowNanos(), name, attributes }),
        end: () => {
          record.endTimeUnixNano = nowNanos();
          pending.push(record);
        },
      } as OtelSpan & { record: Recorded };
    },
  };

  const flush = async () => {
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    const body = {
      resourceSpans: [{
        resource: { attributes: [{ key: 'service.name', value: { stringValue: opts.serviceName ?? 'reinloop' } }] },
        scopeSpans: [{
          scope: { name: 'reinloop' },
          spans: batch.map((r) => ({
            traceId: r.traceId,
            spanId: r.spanId,
            ...(r.parentSpanId && { parentSpanId: r.parentSpanId }),
            name: r.name,
            kind: r.kind,
            startTimeUnixNano: r.startTimeUnixNano,
            endTimeUnixNano: r.endTimeUnixNano,
            attributes: toAttributes(r.attributes),
            ...(r.status && { status: r.status }),
            ...(r.events && { events: r.events.map((e) => ({ timeUnixNano: e.timeUnixNano, name: e.name, attributes: toAttributes(e.attributes) })) }),
          })),
        }],
      }],
    };
    try {
      const signal = exportSignal(exportTimeoutMs);
      const res = await post(url, { method: 'POST', headers: { 'content-type': 'application/json', ...opts.headers }, body: JSON.stringify(body), ...(signal && { signal }) });
      if (!res.ok) throw new ExportStatusError(res.status);
    } catch (err) {
      if (!warned) process.emitWarning(`OTLP export to ${new URL(url).origin} failed: ${exportFailure(err)}`);
      warned = true;
    }
  };

  const timer = setInterval(() => void flush(), opts.intervalMs ?? TELEMETRY_LIMITS['otlp.intervalMs'].default);
  timer.unref();
  const inner = otelSink({ tracer, contextWith: (span) => span, captureContent: opts.captureContent, eventLayers: opts.eventLayers });
  const metrics = opts.metrics
    ? otlpMetricsSink({ endpoint: opts.endpoint, headers: opts.headers, serviceName: opts.serviceName, intervalMs: opts.metricsIntervalMs ?? opts.intervalMs, exportTimeoutMs: opts.exportTimeoutMs, fetch: opts.fetch })
    : undefined;
  return {
    name: 'otlp',
    onEvent: (ev) => {
      inner.onEvent(ev);
      metrics?.onEvent(ev);
    },
    async close() {
      clearInterval(timer);
      await Promise.all([flush(), metrics?.close?.()]);
    },
  };
}
