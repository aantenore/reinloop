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

export function parseArgs(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw ?? {};
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw; // left as string: schema validation reports it back to the model
  }
}
