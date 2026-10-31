export type Attrs = Record<string, string | number | boolean>;

type Value = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean };

const toValue = (v: string | number | boolean): Value =>
  typeof v === 'string' ? { stringValue: v } : typeof v === 'boolean' ? { boolValue: v } : Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };

/** OTLP/JSON `KeyValue[]` from a flat attribute record. */
export const toAttributes = (attrs: Attrs) => Object.entries(attrs).map(([key, v]) => ({ key, value: toValue(v) }));

export const nowNanos = () => (BigInt(Date.now()) * 1_000_000n + BigInt(Math.floor((performance.now() % 1) * 1_000_000))).toString();

/** Throws unless `endpoint` is an absolute URL without credentials: those belong in `headers`. */
export function assertPlainEndpoint(endpoint: string, what: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`${what}: endpoint is not a valid http(s) URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${what}: endpoint is not a valid http(s) URL`);
  if (url.username || url.password) throw new Error(`${what}: the endpoint must not carry credentials; use headers`);
}

/** A collector that answered with an error status. */
export class ExportStatusError extends Error {
  readonly status: number;
  constructor(status: number) {
    super('export failed');
    this.status = status;
  }
}

/**
 * Why an export failed, from a fixed set: `HTTP <status>`, `timeout`, `network error`. Error text and response bodies
 * can echo URLs, headers or payloads, so they are never used in warnings.
 */
export function exportFailure(err: unknown): string {
  if (err instanceof ExportStatusError) return `HTTP ${err.status}`;
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) return 'timeout';
  return 'network error';
}

/** Abort signal for one export POST; none when the limit is off (`Infinity`), so no timer is armed. */
export const exportSignal = (timeoutMs: number): AbortSignal | undefined => (Number.isFinite(timeoutMs) && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined);
