import type { Layer } from '../types.ts';

/**
 * Layer of event types that have no span of their own (they are recorded as span events on the run span):
 * `tool_decision` {callId, name, allowed, reason}, `guardrail` {guard, stage, action, reason},
 * `knowledge_retrieval` {source, query, passages, ids, durationMs, error}. Plugins that emit their own event types
 * pass `eventLayers` to the sink. Event types that are in neither are ignored.
 */
export const EVENT_LAYERS: Readonly<Record<string, Layer>> = {
  tool_decision: 'identity',
  guardrail: 'guardrail',
  knowledge_retrieval: 'knowledge',
};

/** Scalar event fields copied to a span event. */
export const EVENT_ATTR_KEYS: readonly string[] = ['name', 'callId', 'allowed', 'action', 'stage', 'guard', 'source', 'passages', 'durationMs'];
/** Free-text fields (decision reasons, retrieval queries and errors), copied only with `captureContent`. */
export const EVENT_CONTENT_KEYS: readonly string[] = ['reason', 'query', 'error'];

/** Span-event attributes of an event whose type is mapped in a layer table. */
export function eventAttributes(layer: Layer, data: unknown, captureContent?: boolean): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = { 'agent.layer': layer };
  if (!data || typeof data !== 'object') return out;
  const record = data as Record<string, unknown>;
  for (const key of captureContent ? [...EVENT_ATTR_KEYS, ...EVENT_CONTENT_KEYS] : EVENT_ATTR_KEYS) {
    const v = record[key];
    if (typeof v === 'string') out[key] = v.slice(0, 200);
    else if (typeof v === 'number' || typeof v === 'boolean') out[key] = v;
  }
  return out;
}
