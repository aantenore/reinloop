// Shared by the guard adapters. Self-contained on purpose: contract types and node built-ins only, so the adapters
// can be lifted out of this package unchanged.
import type { GuardStage, GuardVerdict } from '../types.ts';

export const GUARD_STAGES: readonly GuardStage[] = ['input', 'output', 'tool_args', 'tool_result'];
const ACTIONS: ReadonlySet<string> = new Set(['allow', 'block', 'redact']);
export const DEFAULT_GUARD_TIMEOUT_MS = 10_000;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface HttpClientOptions {
  headers?: Record<string, string>;
  /** Per-request timeout (default 10 s). */
  timeoutMs?: number;
  /** Replace the global `fetch` (tests, proxies). */
  fetch?: FetchLike;
}

/**
 * A failed guard call. The message is from a fixed set (`HTTP <status>`, `timeout`, `network error`, `invalid response`):
 * raw error text and response bodies can echo URLs with credentials, headers or the inspected text, and guard errors
 * end up in events and run results.
 */
export class GuardCallError extends Error {
  override name = 'GuardCallError';
}

/** Throws unless `url` is an absolute URL without credentials: those belong in `headers` or `token`. */
export function assertPlainUrl(url: string, what: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${what}: not a valid http(s) URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`${what}: not a valid http(s) URL`);
  if (parsed.username || parsed.password) throw new Error(`${what}: the URL must not carry credentials; use headers or token`);
}

/** POSTs JSON and returns the parsed response; non-2xx and non-JSON answers throw a `GuardCallError`. */
export async function postGuardJson(url: string, body: unknown, opts: HttpClientOptions, signal?: AbortSignal): Promise<any> {
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_GUARD_TIMEOUT_MS);
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...opts.headers },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new GuardCallError(err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'network error');
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new GuardCallError(`HTTP ${res.status}`);
  }
  try {
    return await res.json();
  } catch {
    throw new GuardCallError('invalid response');
  }
}

/** Throws unless `value` has the shape of a GuardVerdict; returns it normalized. */
export function parseVerdict(value: unknown): GuardVerdict {
  const v = value as Partial<GuardVerdict> | null;
  if (!v || typeof v !== 'object' || !ACTIONS.has(v.action as string)) throw new GuardCallError('invalid response');
  if (v.action === 'redact' && typeof v.text !== 'string') throw new GuardCallError('invalid response');
  return { action: v.action!, ...(typeof v.text === 'string' && { text: v.text }), ...(typeof v.reason === 'string' && { reason: v.reason }) };
}
