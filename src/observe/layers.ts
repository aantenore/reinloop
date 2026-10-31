import type { Layer } from '../types.ts';

/**
 * Layer of event types that have no span of their own (they are recorded as span events on the run span).
 * Layers added in parallel emit their own event types: extend this table, or pass `eventLayers` to the sink.
 * Event types that are in neither are ignored.
 */
export const EVENT_LAYERS: Readonly<Record<string, Layer>> = {
  tool_decision: 'identity',
  guardrail: 'guardrail',
  knowledge_retrieval: 'knowledge',
  cache_hit: 'cache',
};

/** Scalar event fields copied to a span event. Free text (`reason`) is added only with `captureContent`. */
export const EVENT_ATTR_KEYS: readonly string[] = ['name', 'callId', 'allowed', 'action', 'stage', 'guard', 'tool', 'source', 'count', 'results', 'hit'];

/** Span-event attributes of an event whose type is mapped in a layer table. */
export function eventAttributes(layer: Layer, data: unknown, captureContent?: boolean): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = { 'agent.layer': layer };
  if (!data || typeof data !== 'object') return out;
  const record = data as Record<string, unknown>;
  for (const key of captureContent ? [...EVENT_ATTR_KEYS, 'reason'] : EVENT_ATTR_KEYS) {
    const v = record[key];
    if (typeof v === 'string') out[key] = v.slice(0, 200);
    else if (typeof v === 'number' || typeof v === 'boolean') out[key] = v;
  }
  return out;
}
