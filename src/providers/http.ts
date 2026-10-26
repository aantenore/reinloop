import { errorMessage, ProviderError, truncate } from '../util.ts';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export async function postJson(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
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
    throw new ProviderError(res.status, `HTTP ${res.status} from ${url}: ${truncate(text, 500)}`, retryAfter(res.headers));
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

/** Minimal Server-Sent Events reader over a fetch Response body. */
export async function* readSse(res: Response): AsyncGenerator<SseEvent> {
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
