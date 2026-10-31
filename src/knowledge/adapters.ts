import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { McpClient, type McpServerConfig } from '../mcp/client.ts';
import { type Note, rank } from '../tools/memory.ts';
import type { KnowledgeQuery, KnowledgeSource, Passage } from '../types.ts';
import { DEFAULT_K, DEFAULT_TIMEOUT_MS, hashId, matchesFilter, toPassage } from './core.ts';

export interface ClosableSource extends KnowledgeSource { close(): Promise<void> }

// ---- MCP -------------------------------------------------------------------

/** What the adapter needs from an MCP client; `McpClient` satisfies it. */
export interface McpCaller {
  callTool(name: string, args: unknown, signal?: AbortSignal): Promise<{ content: string; isError: boolean }>;
  close?(): Promise<void>;
}

export interface McpKnowledgeOptions {
  /** Source name used in citations and events (default: the tool name). */
  name?: string;
  /** An already connected client (not closed by this source)... */
  client?: McpCaller;
  /** ...or a server to connect to on first use (stdio `command` or HTTP `url`); `close()` ends it. */
  server?: McpServerConfig;
  /** MCP tool that retrieves passages, e.g. `qdrant-find`. */
  tool: string;
  /** Tool arguments for a query (default `{ query }`). */
  args?: (q: KnowledgeQuery) => Record<string, unknown>;
  /** Turns the tool result into passages (default: {@link parseMcpResult}). */
  parse?: (result: { content: string; isError: boolean }, q: KnowledgeQuery) => Passage[];
}

const ENTRY = /<entry>\s*<content>([\s\S]*?)<\/content>\s*<metadata>([\s\S]*?)<\/metadata>\s*<\/entry>/g;
const JSON_LISTS = ['passages', 'results', 'documents', 'points', 'items', 'data'];

function fromJson(value: unknown, source: string): Passage[] | undefined {
  const list = Array.isArray(value)
    ? value
    : typeof value === 'object' && value !== null
      ? JSON_LISTS.map((k) => (value as Record<string, unknown>)[k]).find(Array.isArray)
      : undefined;
  return list?.flatMap((item: unknown) => toPassage(item, source) ?? []);
}

/**
 * Default parser for MCP retrieval tools. Understands, in order: a JSON array or `{ passages | results | ... }` object,
 * the `<entry><content>..</content><metadata>{json}</metadata></entry>` output of mcp-server-qdrant (the metadata `id`,
 * when present, becomes the passage id), and otherwise treats the text as one passage.
 */
export function parseMcpResult(result: { content: string; isError: boolean }, source: string): Passage[] {
  const text = result.content.trim();
  if (!text) return [];
  if (text[0] === '[' || text[0] === '{') {
    try {
      const found = fromJson(JSON.parse(text), source);
      if (found) return found;
    } catch {
      // not JSON: fall through
    }
  }
  const entries = [...text.matchAll(ENTRY)];
  if (entries.length) {
    return entries.map(([, content, meta]) => {
      let metadata: Record<string, unknown> | undefined;
      try {
        const parsed = meta!.trim() ? JSON.parse(meta!) : undefined;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) metadata = parsed;
      } catch {
        // metadata is informative only
      }
      const body = content!.trim();
      const id = metadata?.id;
      return { id: typeof id === 'string' || typeof id === 'number' ? String(id) : hashId(body), text: body, source, ...(metadata && { metadata }) };
    });
  }
  if (/^no (information|results?) found/i.test(text)) return [];
  return [{ id: hashId(text), text, source }];
}

/** Retrieval through an MCP tool (standard: MCP tools). The default parser covers mcp-server-qdrant. */
export function mcpKnowledge(opts: McpKnowledgeOptions): ClosableSource {
  if (!opts.client === !opts.server) throw new Error('mcpKnowledge: set exactly one of "client" or "server"');
  const name = opts.name ?? opts.tool;
  let connecting: Promise<McpCaller> | undefined;
  const caller = (): Promise<McpCaller> => {
    if (opts.client) return Promise.resolve(opts.client);
    connecting ??= McpClient.connect(name, opts.server!);
    connecting.catch(() => (connecting = undefined)); // retry the connection on the next query
    return connecting;
  };
  return {
    name,
    async search(q) {
      const client = await caller();
      const res = await client.callTool(opts.tool, opts.args ? opts.args(q) : { query: q.query }, q.signal);
      if (res.isError) throw new Error(`MCP tool ${opts.tool} failed: ${res.content.slice(0, 300)}`);
      const passages = opts.parse ? opts.parse(res, q) : parseMcpResult(res, name);
      return passages.filter((p) => matchesFilter(p.metadata, q.filter)).slice(0, q.k ?? passages.length);
    },
    async close() {
      if (!opts.server || !connecting) return;
      const pending = connecting;
      connecting = undefined;
      await (await pending.catch(() => undefined))?.close?.();
    },
  };
}

// ---- HTTP ------------------------------------------------------------------

export interface HttpKnowledgeOptions {
  name?: string;
  url: string;
  /** Static headers, or a function of the query (e.g. to forward `identity.token` as a bearer token). */
  headers?: Record<string, string> | ((q: KnowledgeQuery) => Record<string, string>);
  timeoutMs?: number;
}

/** Retrieval through `POST url` with `{ query, k, filter }` returning `{ passages: Passage[] }`. */
export function httpKnowledge(opts: HttpKnowledgeOptions): KnowledgeSource {
  const name = opts.name ?? new URL(opts.url).host;
  return {
    name,
    async search(q) {
      const timeout = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const res = await fetch(opts.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...(typeof opts.headers === 'function' ? opts.headers(q) : opts.headers) },
        body: JSON.stringify({ query: q.query, ...(q.k !== undefined && { k: q.k }), ...(q.filter && { filter: q.filter }) }),
        signal: q.signal ? AbortSignal.any([q.signal, timeout]) : timeout,
      });
      if (!res.ok) throw new Error(`knowledge HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
      const body = (await res.json()) as { passages?: unknown };
      if (!Array.isArray(body?.passages)) throw new Error('knowledge HTTP: response has no "passages" array');
      return body.passages.flatMap((p) => toPassage(p, name) ?? []);
    },
  };
}

// ---- Markdown wiki ---------------------------------------------------------

export interface WikiKnowledgeOptions {
  name?: string;
  /** Folder with Markdown files (searched recursively). */
  dir: string;
  /** Sections longer than this are split on blank lines (default 1500). */
  maxPassageChars?: number;
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const slug = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');

async function markdownFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const path = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await markdownFiles(path)));
    else if (e.isFile() && /\.(md|markdown)$/i.test(e.name)) out.push(path);
  }
  return out.sort();
}

/** Splits Markdown into sections by heading (headings inside code fences are ignored); a section keeps its heading path. */
export function splitMarkdown(text: string, file: string, maxChars = 1500): Passage[] {
  const out: Passage[] = [];
  const path: string[] = [];
  let body: string[] = [];
  let fence = false;
  const flush = () => {
    const content = body.join('\n').trim();
    body = [];
    if (!content) return;
    const heading = path.join(' > ');
    const base = `${file}${path.length ? `#${slug(path[path.length - 1]!)}` : ''}`;
    const chunks: string[] = [];
    let cur = '';
    for (const para of content.split(/\n\s*\n/)) {
      if (cur && cur.length + para.length > maxChars) (chunks.push(cur), (cur = ''));
      cur = cur ? `${cur}\n\n${para}` : para;
    }
    if (cur) chunks.push(cur);
    chunks.forEach((chunk, i) =>
      out.push({
        id: chunks.length > 1 ? `${base}~${i + 1}` : base,
        text: heading ? `${heading}\n${chunk}` : chunk,
        source: file,
        metadata: { path: file, ...(heading && { heading }) },
      }),
    );
  };
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const m = fence ? null : HEADING.exec(line);
    if (m) {
      flush();
      path.length = Math.min(path.length, m[1]!.length - 1);
      path.push(m[2]!);
    } else body.push(line);
  }
  flush();
  return out;
}

/**
 * "LLM wiki": a folder of Markdown pages, split by heading and ranked by keyword overlap (the `recall` ranking).
 * Files are read on every search, so edits show up immediately; use a vector source for large corpora.
 */
export function wikiKnowledge(opts: WikiKnowledgeOptions): KnowledgeSource {
  const name = opts.name ?? 'wiki';
  return {
    name,
    async search(q) {
      const passages: Passage[] = [];
      for (const file of await markdownFiles(opts.dir)) {
        const rel = relative(opts.dir, file).split(sep).join('/');
        passages.push(...splitMarkdown(await readFile(file, 'utf8'), rel, opts.maxPassageChars));
      }
      const pool = passages.filter((p) => matchesFilter(p.metadata, q.filter));
      const notes = new Map<Note, Passage>(pool.map((p) => [{ text: p.text, tags: [p.id], agent: name, ts: 0 }, p]));
      return rank([...notes.keys()], q.query, q.k ?? DEFAULT_K).map((n) => notes.get(n)!);
    },
  };
}
