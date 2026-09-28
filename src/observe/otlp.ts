import { randomBytes } from 'node:crypto';
import type { Sink } from '../types.ts';
import { errorMessage } from '../util.ts';
import { type OtelSpan, type OtelTracer, otelSink } from './otel.ts';

export interface OtlpOptions {
  /** Collector base URL (e.g. http://localhost:4318) or the full `/v1/traces` URL. */
  endpoint: string;
  headers?: Record<string, string>;
  serviceName?: string;
  captureContent?: boolean;
  /** Export interval for finished spans (default 2000 ms). Remaining spans are sent on close. */
  intervalMs?: number;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

type Value = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean };

const toValue = (v: string | number | boolean): Value =>
  typeof v === 'string' ? { stringValue: v } : typeof v === 'boolean' ? { boolValue: v } : Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };

const nowNanos = () => (BigInt(Date.now()) * 1_000_000n + BigInt(Math.floor((performance.now() % 1) * 1_000_000))).toString();

interface Recorded {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano?: string;
  attributes: Record<string, string | number | boolean>;
  status?: { code: number; message?: string };
}

/**
 * Exports run events as OpenTelemetry spans over OTLP/HTTP JSON, with no SDK. Works with any collector and
 * with backends that accept OTLP JSON directly; put an OpenTelemetry Collector in front of protobuf-only ones.
 */
export function otlpSink(opts: OtlpOptions): Sink {
  const url = /\/v1\/traces\/?$/.test(opts.endpoint) ? opts.endpoint : `${opts.endpoint.replace(/\/+$/, '')}/v1/traces`;
  const post = opts.fetch ?? fetch;
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
            attributes: Object.entries(r.attributes).map(([key, v]) => ({ key, value: toValue(v) })),
            ...(r.status && { status: r.status }),
          })),
        }],
      }],
    };
    try {
      const res = await post(url, { method: 'POST', headers: { 'content-type': 'application/json', ...opts.headers }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
    } catch (err) {
      if (!warned) process.emitWarning(`OTLP export to ${url} failed: ${errorMessage(err)}`);
      warned = true;
    }
  };

  const timer = setInterval(() => void flush(), opts.intervalMs ?? 2000);
  timer.unref();
  const inner = otelSink({ tracer, contextWith: (span) => span, captureContent: opts.captureContent });
  return {
    name: 'otlp',
    onEvent: (ev) => inner.onEvent(ev),
    async close() {
      clearInterval(timer);
      await flush();
    },
  };
}
