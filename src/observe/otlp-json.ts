export type Attrs = Record<string, string | number | boolean>;

type Value = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean };

const toValue = (v: string | number | boolean): Value =>
  typeof v === 'string' ? { stringValue: v } : typeof v === 'boolean' ? { boolValue: v } : Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };

/** OTLP/JSON `KeyValue[]` from a flat attribute record. */
export const toAttributes = (attrs: Attrs) => Object.entries(attrs).map(([key, v]) => ({ key, value: toValue(v) }));

export const nowNanos = () => (BigInt(Date.now()) * 1_000_000n + BigInt(Math.floor((performance.now() % 1) * 1_000_000))).toString();
