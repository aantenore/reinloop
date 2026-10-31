import { finiteTimeout, limitDefault } from '../limits.ts';
import { errorMessage, ProviderError, truncate } from '../util.ts';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/**
 * A model request that ran past its time limit. Named `TimeoutError` like the platform's timeout errors, and status 408
 * so `withRetry` treats it like any other request timeout. The message names neither the URL nor the request.
 */
export class ProviderTimeoutError extends ProviderError {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(408, `model request timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/** Time limit of one model request; `touch` restarts it (a stream calls it on every chunk). */
export interface Deadline {
  /** The caller's signal combined with the limit. With no limit it is the caller's signal itself. */
  readonly signal: AbortSignal;
  touch(): void;
  stop(): void;
  /** Set once the limit fired. */
  readonly timeout?: ProviderTimeoutError;
}

/** `timeoutMs` that is not finite and positive (unbounded) arms no timer. */
export function deadline(timeoutMs: number | undefined, caller: AbortSignal): Deadline {
  const ms = finiteTimeout(timeoutMs);
  if (!ms) return { signal: caller, touch() {}, stop() {} };
  const ctl = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const fire = () => {
    dl.timeout = new ProviderTimeoutError(ms);
    ctl.abort(dl.timeout);
  };
  const stop = () => {
    clearTimeout(timer);
    timer = undefined;
    caller.removeEventListener('abort', stop);
  };
  const dl: { signal: AbortSignal; touch(): void; stop(): void; timeout?: ProviderTimeoutError } = {
    signal: AbortSignal.any([caller, ctl.signal]),
    touch: () => timer?.refresh(),
    stop,
  };
  timer = setTimeout(fire, ms);
  caller.addEventListener('abort', stop, { once: true });
  return dl;
}

/**
 * Runs one model request under a time limit (see `PROVIDER_TIMEOUT_LIMITS`) and always releases the timer. A request
 * that the limit ended rejects with `ProviderTimeoutError`; one the caller aborted rejects as the caller's signal says.
 */
export async function withDeadline<T>(timeoutMs: number | undefined, caller: AbortSignal, run: (dl: Deadline) => Promise<T>): Promise<T> {
  const dl = deadline(timeoutMs, caller);
  try {
    return await run(dl);
  } catch (err) {
    if (dl.timeout && !caller.aborted) throw dl.timeout;
    throw err;
  } finally {
    dl.stop();
  }
}

export const requestTimeoutMs = (configured: number | undefined): number => configured ?? limitDefault('provider.timeoutMs');

export async function postJson(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
  errorBodyChars: number = limitDefault('provider.errorBodyChars'),
): Promise<Response> {
  let res: Response;
  try {
    res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
  } catch (err) {
    if (signal.aborted) throw err;
    throw new ProviderError(0, `network error: ${errorMessage(err)}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ProviderError(res.status, `HTTP ${res.status} from ${url}: ${truncate(text, errorBodyChars)}`, retryAfter(res.headers));
  }
  return res;
}

function retryAfter(headers: Headers): number | undefined {
  const ms = headers.get('retry-after-ms');
  if (ms && Number.isFinite(Number(ms))) return Number(ms);
  const value = headers.get('retry-after');
  if (!value) return undefined;
  if (Number.isFinite(Number(value))) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

export interface SseEvent { event?: string; data: string }

/** Minimal Server-Sent Events reader over a fetch Response body. `onChunk` is called for every chunk received. */
export async function* readSse(res: Response, onChunk?: () => void): AsyncGenerator<SseEvent> {
  if (!res.body) return;
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let finished = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        finished = true;
        break;
      }
      onChunk?.();
      buffer += value;
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const raw = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const ev = parseSse(raw);
        if (ev) yield ev;
      }
    }
    const tail = parseSse(buffer);
    if (tail) yield tail;
  } finally {
    if (!finished) await reader.cancel().catch(() => {}); // closes the connection when we stop early
    reader.releaseLock();
  }
}

function parseSse(raw: string): SseEvent | undefined {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    const i = line.indexOf(':');
    const field = i < 0 ? line : line.slice(0, i);
    const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  return data.length ? { event, data: data.join('\n') } : undefined;
}

/**
 * Parses tool-call arguments streamed as JSON text, repairing common damage: trailing commas, unterminated strings,
 * unclosed objects/arrays and a dangling key, comma or colon (e.g. output cut at max_tokens). Returns the value, with
 * `repaired` set to the original parse error when a repair was needed, or `error` when the text cannot be repaired.
 * A string, number or literal cut off mid-way is not repaired: completing it would hand a tool silently altered values.
 */
export function parseToolJson(raw: string): { value: unknown; repaired?: string } | { error: string } {
  if (!raw.trim()) return { value: {} };
  let original: string;
  try {
    return { value: JSON.parse(raw) };
  } catch (err) {
    original = err instanceof Error ? err.message : String(err);
  }
  const fixed = repairJsonText(raw);
  if (fixed === null) return { error: `${original} (a value is cut off; output truncated?)` };
  if (fixed !== undefined) {
    try {
      return { value: JSON.parse(fixed), repaired: original };
    } catch {
      // fall through
    }
  }
  return { error: original };
}

function repairJsonText(raw: string): string | null | undefined {
  const stack: string[] = [];
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of raw.trim()) {
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') {
      if (stack.pop() !== ch) return undefined;
      out = out.replace(/,\s*$/, '');
    }
    out += ch;
  }
  const inObject = stack.at(-1) === '}';
  if (inString) {
    // An unterminated key can be dropped below; an unterminated value cannot be completed safely.
    const key = inObject ? /([{,])\s*"(?:[^"\\]|\\.)*\\?$/.exec(out) : null;
    if (!key) return null;
    out = out.slice(0, key.index + 1);
  } else if (stack.length && /[\w.+-]$/.test(out.trimEnd())) {
    // A number or literal right before the cut may itself be cut (`12` of `123`): not repaired either.
    return null;
  }
  // Drop what cannot be completed: a trailing comma, a key without value (objects only), a dangling colon.
  for (let prev = ''; prev !== out; ) {
    prev = out;
    out = out.replace(/,\s*$/, '');
    if (inObject) out = out.replace(/([{,])\s*"(?:[^"\\]|\\.)*"\s*:?\s*$/, '$1');
  }
  return out + stack.reverse().join('');
}

export function parseArgs(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw ?? {};
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw; // left as string: schema validation reports it back to the model
  }
}
