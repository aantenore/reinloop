import type { RunEvent, Sink } from '../types.ts';

/** Structural subset of `@opentelemetry/api` so the kernel needs no dependency. */
export interface OtelSpan {
  setAttribute(key: string, value: string | number | boolean): unknown;
  setStatus(status: { code: number; message?: string }): unknown;
  end(): void;
}
export interface OtelTracer {
  startSpan(name: string, options?: { attributes?: Record<string, string | number | boolean>; kind?: number }, context?: unknown): OtelSpan;
}

export interface OtelSinkOptions {
  tracer: OtelTracer;
  /** Returns a context carrying `span` as parent, e.g. `(s) => trace.setSpan(context.active(), s)`. */
  contextWith?: (span: OtelSpan) => unknown;
  providerName?: string;
  /** Record message content on spans (off by default: may contain sensitive data). */
  captureContent?: boolean;
}

const ERROR = 2;
const CLIENT = 2;
const INTERNAL = 0;

/** Maps run events to spans following the OpenTelemetry GenAI semantic conventions. */
export function otelSink(opts: OtelSinkOptions): Sink {
  const runs = new Map<string, OtelSpan>();
  const open = new Map<string, OtelSpan>();
  const start = (name: string, parent: OtelSpan | undefined, attributes: Record<string, string | number | boolean>, kind = INTERNAL) =>
    opts.tracer.startSpan(name, { attributes, kind }, parent && opts.contextWith ? opts.contextWith(parent) : undefined);

  return {
    onEvent(ev: RunEvent) {
      const parentOf = (runId: string) => runs.get(runId);
      switch (ev.type) {
        case 'run_start': {
          const parent = ev.parentRunId ? parentOf(ev.parentRunId) : undefined;
          runs.set(ev.runId, start(`invoke_agent ${ev.data.agent}`, parent, {
            'gen_ai.operation.name': 'invoke_agent',
            'gen_ai.agent.name': ev.data.agent,
            'gen_ai.conversation.id': ev.runId,
          }));
          break;
        }
        case 'model_request':
          open.set(`${ev.runId}:model`, start(`chat ${ev.data.model}`, parentOf(ev.runId), {
            'gen_ai.operation.name': 'chat',
            'gen_ai.request.model': ev.data.model,
            ...(opts.providerName && { 'gen_ai.provider.name': opts.providerName }),
          }, CLIENT));
          break;
        case 'model_response': {
          const span = open.get(`${ev.runId}:model`);
          if (!span) break;
          open.delete(`${ev.runId}:model`);
          span.setAttribute('gen_ai.response.model', ev.data.model);
          span.setAttribute('gen_ai.response.finish_reasons', ev.data.stopReason);
          span.setAttribute('gen_ai.usage.input_tokens', ev.data.usage.inputTokens);
          span.setAttribute('gen_ai.usage.output_tokens', ev.data.usage.outputTokens);
          if (ev.data.usage.cacheReadTokens) span.setAttribute('gen_ai.usage.cache_read.input_tokens', ev.data.usage.cacheReadTokens);
          if (opts.captureContent) span.setAttribute('gen_ai.output.messages', JSON.stringify([ev.data.message]));
          span.end();
          break;
        }
        case 'tool_start':
          open.set(`${ev.runId}:tool:${ev.data.callId}`, start(`execute_tool ${ev.data.name}`, parentOf(ev.runId), {
            'gen_ai.operation.name': 'execute_tool',
            'gen_ai.tool.name': ev.data.name,
            'gen_ai.tool.call.id': ev.data.callId,
            ...(opts.captureContent && { 'gen_ai.tool.call.arguments': JSON.stringify(ev.data.args) }),
          }));
          break;
        case 'tool_result': {
          const key = `${ev.runId}:tool:${ev.data.callId}`;
          const span = open.get(key);
          if (!span) break;
          open.delete(key);
          if (ev.data.isError) span.setStatus({ code: ERROR, message: ev.data.content.slice(0, 200) });
          if (opts.captureContent) span.setAttribute('gen_ai.tool.call.result', ev.data.content);
          span.end();
          break;
        }
        case 'run_end': {
          for (const [key, span] of open) {
            if (key.startsWith(`${ev.runId}:`)) {
              span.end();
              open.delete(key);
            }
          }
          const span = runs.get(ev.runId);
          if (!span) break;
          runs.delete(ev.runId);
          span.setAttribute('gen_ai.usage.input_tokens', ev.data.usage.inputTokens);
          span.setAttribute('gen_ai.usage.output_tokens', ev.data.usage.outputTokens);
          if (ev.data.status !== 'completed') span.setStatus({ code: ERROR, message: `${ev.data.status}${ev.data.reason ? `: ${ev.data.reason}` : ''}` });
          span.end();
          break;
        }
      }
    },
  };
}
