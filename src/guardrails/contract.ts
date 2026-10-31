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

/** POSTs JSON and returns the parsed response; non-2xx and non-JSON answers throw. */
export async function postGuardJson(url: string, body: unknown, opts: HttpClientOptions, signal?: AbortSignal): Promise<any> {
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_GUARD_TIMEOUT_MS);
  const res = await (opts.fetch ?? fetch)(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...opts.headers },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  try {
    return await res.json();
  } catch {
    throw new Error(`${url} did not return JSON`);
  }
}

/** Throws unless `value` has the shape of a GuardVerdict; returns it normalized. */
export function parseVerdict(value: unknown): GuardVerdict {
  const v = value as Partial<GuardVerdict> | null;
  if (!v || typeof v !== 'object' || !ACTIONS.has(v.action as string)) throw new Error(`invalid guard verdict: ${JSON.stringify(value)?.slice(0, 120)}`);
  if (v.action === 'redact' && typeof v.text !== 'string') throw new Error('invalid guard verdict: redact without text');
  return { action: v.action!, ...(typeof v.text === 'string' && { text: v.text }), ...(typeof v.reason === 'string' && { reason: v.reason }) };
}
