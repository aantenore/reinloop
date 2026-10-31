import type { FetchLike } from '../providers/http.ts';
import { limitDefault } from '../limits.ts';
import type { Tool } from '../types.ts';
import { errorMessage, truncate } from '../util.ts';
import { VERSION } from '../version.ts';
import { defineTool } from './define.ts';
import { ttlCache, UNTRUSTED_NOTE } from './web.ts';

/** One result row of a signal source: flat, JSON-serializable fields. */
export type SignalItem = Record<string, string | number | boolean | string[] | null | undefined>;

export interface SignalSearchOptions {
  maxResults: number;
  signal: AbortSignal;
  /** GET helper with timeout, User-Agent and rate-limit handling; returns the parsed body (JSON or text). */
  get(url: string, init?: { headers?: Record<string, string>; as?: 'json' | 'text' }): Promise<any>;
  /** Characters kept for long free-text fields (descriptions, summaries). */
  maxChars: number;
}

/** Pluggable public-signal backend. Each source becomes one tool named `tool`. */
export interface SignalSource {
  /** Short source id reported in results, e.g. `hackernews`. */
  readonly name: string;
  /** Tool name, e.g. `search_discussions`. */
  readonly tool: string;
  readonly description: string;
  search(query: string, opts: SignalSearchOptions): Promise<SignalItem[]>;
}

export type BuiltinSignalSource = 'hackernews' | 'github' | 'stackoverflow' | 'arxiv';

export interface SignalToolsOptions {
  /** Built-in source names or custom `SignalSource`s (default: all four built-ins). */
  sources?: Array<BuiltinSignalSource | SignalSource>;
  /** Default results per search (default 5); the model may ask for up to `maxResultsCap` (default 10). */
  maxResults?: number;
  maxResultsCap?: number;
  /** Characters kept per free-text field such as a description (default 300). */
  maxChars?: number;
  /** In-memory cache of results for this many ms (default 0: off). */
  cacheTtlMs?: number;
  /** Per-request timeout in ms (default 10000). */
  timeoutMs?: number;
  /** Results kept by the cache (default 200). */
  cacheMaxEntries?: number;
  /** Response text kept in an HTTP error (default 300). */
  errorBodyChars?: number;
  /** Response text kept in a throttling error (default 200). */
  rateLimitBodyChars?: number;
  /** GitHub token for higher rate limits (default env `GITHUB_TOKEN`). Sent only to api.github.com. */
  githubToken?: string;
  /** Also search GitHub issues in `search_projects` (default false; one extra request). */
  githubIssues?: boolean;
  /** Stack Exchange site (default `stackoverflow`). */
  stackExchangeSite?: string;
  /** User-Agent sent with every request (default `reinloop/<version> (+repo url)`). */
  userAgent?: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
}

/** Thrown by sources when the upstream API refuses because of rate limits or quota. */
export class SignalRateLimitError extends Error {
  constructor(source: string, detail: string) {
    super(`${source} rate limit reached: ${detail}`);
    this.name = 'SignalRateLimitError';
  }
}

const DEFAULT_UA = `reinloop/${VERSION} (+https://github.com/aantenore/reinloop)`;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
/** Decodes the HTML/XML entities these APIs put in titles. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const clean = (s: unknown, max: number) => truncate(decodeEntities(String(s ?? '')).replace(/\s+/g, ' ').trim(), max);
const isoFromEpoch = (s: unknown) => (typeof s === 'number' ? new Date(s * 1000).toISOString() : undefined);

export function hackerNewsSource(): SignalSource {
  return {
    name: 'hackernews',
    tool: 'search_discussions',
    description: 'Search Hacker News stories (via the Algolia HN API). Returns title, URL, points, comment count and the HN thread link (untrusted external content).',
    async search(query, { maxResults, get, maxChars }) {
      const p = new URLSearchParams({ query, tags: 'story', hitsPerPage: String(maxResults) });
      const json = await get(`https://hn.algolia.com/api/v1/search?${p}`);
      return (json?.hits ?? []).map((h: any) => ({
        title: clean(h.title, maxChars),
        url: h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`,
        points: h.points ?? 0,
        comments: h.num_comments ?? 0,
        created_at: h.created_at,
        hn_url: `https://news.ycombinator.com/item?id=${h.objectID}`,
      }));
    },
  };
}

export function githubSource(opts: { token?: string; issues?: boolean } = {}): SignalSource {
  const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(opts.token && { authorization: `Bearer ${opts.token}` }) };
  return {
    name: 'github',
    tool: 'search_projects',
    description: `Search GitHub repositories by stars${opts.issues ? ' (plus matching issues)' : ''}. Returns name, URL, stars, open issues, last push and a short description (untrusted external content).`,
    async search(query, { maxResults, get, maxChars }) {
      const p = new URLSearchParams({ q: query, sort: 'stars', order: 'desc', per_page: String(maxResults) });
      const repos = await get(`https://api.github.com/search/repositories?${p}`, { headers });
      const out: SignalItem[] = (repos?.items ?? []).map((r: any) => ({
        name: r.full_name,
        url: r.html_url,
        stars: r.stargazers_count ?? 0,
        open_issues: r.open_issues_count ?? 0,
        pushed_at: r.pushed_at,
        description: clean(r.description, maxChars),
      }));
      if (!opts.issues) return out;
      const ip = new URLSearchParams({ q: `${query} is:issue`, sort: 'reactions', order: 'desc', per_page: String(maxResults) });
      const issues = await get(`https://api.github.com/search/issues?${ip}`, { headers });
      for (const i of issues?.items ?? []) {
        out.push({
          kind: 'issue',
          title: clean(i.title, maxChars),
          url: i.html_url,
          state: i.state,
          comments: i.comments ?? 0,
          updated_at: i.updated_at,
          repo: String(i.repository_url ?? '').replace('https://api.github.com/repos/', ''),
        });
      }
      return out;
    },
  };
}

export function stackExchangeSource(opts: { site?: string } = {}): SignalSource {
  const site = opts.site ?? 'stackoverflow';
  return {
    name: site,
    tool: 'search_questions',
    description: `Search ${site} questions by relevance. Returns title, URL, score, answer count and whether it is answered (untrusted external content).`,
    async search(query, { maxResults, get, maxChars }) {
      const p = new URLSearchParams({ order: 'desc', sort: 'relevance', q: query, site, pagesize: String(maxResults) });
      const json = await get(`https://api.stackexchange.com/2.3/search/advanced?${p}`);
      if (json?.error_id) {
        if (json.error_id === 502 || json.error_name === 'throttle_violation') throw new SignalRateLimitError(site, String(json.error_message ?? 'throttled'));
        throw new Error(`${site}: ${json.error_name ?? json.error_id}: ${json.error_message ?? ''}`);
      }
      if (json?.quota_remaining === 0 && !json?.items?.length) throw new SignalRateLimitError(site, 'daily quota exhausted');
      return (json?.items ?? []).map((q: any) => ({
        title: clean(q.title, maxChars),
        url: q.link,
        score: q.score ?? 0,
        answer_count: q.answer_count ?? 0,
        is_answered: Boolean(q.is_answered),
        creation_date: isoFromEpoch(q.creation_date),
      }));
    },
  };
}

/** Minimal Atom parsing of an arXiv API response (no dependencies). */
export function parseArxivAtom(xml: string, maxChars: number = limitDefault('signals.maxChars')): SignalItem[] {
  const field = (block: string, name: string) => new RegExp(`<(?:[a-z]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[a-z]+:)?${name}>`, 'i').exec(block)?.[1];
  const entries = [...xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi)].map((m) => m[1]!);
  return entries.map((e) => {
    const authors = [...e.matchAll(/<author(?:\s[^>]*)?>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi)].map((m) => clean(m[1], 100));
    const id = clean(field(e, 'id'), 500);
    return {
      title: clean(field(e, 'title'), maxChars),
      url: id.replace(/^http:\/\//, 'https://'),
      published: clean(field(e, 'published'), 40),
      authors: authors.slice(0, 3),
      ...(authors.length > 3 && { more_authors: authors.length - 3 }),
    };
  });
}

export function arxivSource(): SignalSource {
  return {
    name: 'arxiv',
    tool: 'search_papers',
    description: 'Search arXiv papers. Returns title, abstract URL, publication date and the first authors (untrusted external content).',
    async search(query, { maxResults, get, maxChars }) {
      const terms = query.replace(/["():]/g, ' ').split(/\s+/).filter(Boolean);
      const p = new URLSearchParams({ search_query: terms.map((t) => `all:${t}`).join(' AND '), start: '0', max_results: String(maxResults), sortBy: 'relevance' });
      const xml: string = await get(`https://export.arxiv.org/api/query?${p}`, { as: 'text' });
      return parseArxivAtom(xml, maxChars);
    },
  };
}

function rateLimitDetail(res: Response): string | undefined {
  const h = res.headers;
  const reset = Number(h.get('x-ratelimit-reset'));
  const retry = h.get('retry-after');
  if (res.status === 429 || (res.status === 403 && h.get('x-ratelimit-remaining') === '0')) {
    const when = Number.isFinite(reset) && reset > 0 ? `resets at ${new Date(reset * 1000).toISOString()}` : retry ? `retry after ${retry}s` : 'retry later';
    return when;
  }
  if (res.status === 403 && retry) return `secondary limit, retry after ${retry}s`;
  return undefined;
}

interface ErrorExcerpts { errorBodyChars: number; rateLimitBodyChars: number }

function httpGetter(fetchImpl: FetchLike, userAgent: string, timeoutMs: number, source: string, signal: AbortSignal, excerpts: ErrorExcerpts): SignalSearchOptions['get'] {
  return async (url, init = {}) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(url, { method: 'GET', headers: { 'user-agent': userAgent, ...init.headers }, signal: AbortSignal.any([signal, timeout]) });
    } catch (err) {
      if (signal.aborted) throw err;
      if (timeout.aborted) throw new Error(`${source}: request timed out after ${timeoutMs} ms`);
      throw new Error(`${source}: network error: ${errorMessage(err)}`);
    }
    const limited = rateLimitDetail(res);
    if (limited) {
      const hint = source === 'github' && Number(res.headers.get('x-ratelimit-limit') ?? 0) < 1000 ? ' (set GITHUB_TOKEN for a higher limit)' : '';
      throw new SignalRateLimitError(source, limited + hint);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // Stack Exchange reports throttling as HTTP 400 with error_name `throttle_violation`.
      if (body.includes('throttle_violation')) throw new SignalRateLimitError(source, truncate(body, excerpts.rateLimitBodyChars));
      throw new Error(`${source}: HTTP ${res.status}: ${truncate(body, excerpts.errorBodyChars)}`);
    }
    return init.as === 'text' ? res.text() : res.json();
  };
}

export const BUILTIN_SIGNAL_SOURCES: readonly BuiltinSignalSource[] = ['hackernews', 'github', 'stackoverflow', 'arxiv'];

function sourceFrom(s: BuiltinSignalSource | SignalSource, opts: SignalToolsOptions): SignalSource {
  if (typeof s !== 'string') return s;
  switch (s) {
    case 'hackernews':
      return hackerNewsSource();
    case 'github':
      return githubSource({ token: opts.githubToken ?? (opts.env ?? process.env).GITHUB_TOKEN, issues: opts.githubIssues });
    case 'stackoverflow':
      return stackExchangeSource({ site: opts.stackExchangeSite });
    case 'arxiv':
      return arxivSource();
    default:
      throw new Error(`unknown signal source "${s}" (built-in: ${BUILTIN_SIGNAL_SOURCES.join(', ')}; or pass a SignalSource)`);
  }
}

export interface SignalTools {
  search_discussions?: Tool;
  search_projects?: Tool;
  search_questions?: Tool;
  search_papers?: Tool;
  [tool: string]: Tool | undefined;
}

/**
 * Public-signal research tools (risk `read`), one per source: `search_discussions` (Hacker News), `search_projects`
 * (GitHub), `search_questions` (Stack Overflow), `search_papers` (arXiv), plus custom `SignalSource`s. Results are
 * compact JSON marked `untrusted: true` with `source` and `retrieved_at`; calls count against `maxToolCalls`.
 * Rate limits come back as tool errors so the model can move on.
 */
export function signalTools(opts: SignalToolsOptions = {}): SignalTools {
  const cap = opts.maxResultsCap ?? limitDefault('signals.maxResultsCap');
  const maxChars = opts.maxChars ?? limitDefault('signals.maxChars');
  const timeoutMs = opts.timeoutMs ?? limitDefault('signals.timeoutMs');
  const excerpts: ErrorExcerpts = {
    errorBodyChars: opts.errorBodyChars ?? limitDefault('signals.errorBodyChars'),
    rateLimitBodyChars: opts.rateLimitBodyChars ?? limitDefault('signals.rateLimitBodyChars'),
  };
  const userAgent = opts.userAgent ?? DEFAULT_UA;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const cache = ttlCache(opts.cacheTtlMs ?? limitDefault('signals.cacheTtlMs'), opts.cacheMaxEntries ?? limitDefault('signals.cacheMaxEntries'));
  const out: SignalTools = {};
  for (const spec of opts.sources ?? BUILTIN_SIGNAL_SOURCES) {
    const source = sourceFrom(spec, opts);
    if (out[source.tool]) throw new Error(`two signal sources define the tool "${source.tool}"`);
    out[source.tool] = defineTool<{ query: string; max_results?: number }>({
      name: source.tool,
      description: source.description,
      risk: 'read',
      schema: {
        type: 'object',
        properties: { query: { type: 'string', minLength: 1 }, max_results: { type: 'integer', minimum: 1, maximum: cap } },
        required: ['query'],
        additionalProperties: false,
      },
      run: async ({ query, max_results }, ctx) => {
        const n = Math.min(max_results ?? opts.maxResults ?? limitDefault('signals.maxResults'), cap);
        try {
          return await cache.get(`${source.tool}\u0000${n}\u0000${query}`, async () => {
            const get = httpGetter(fetchImpl, userAgent, timeoutMs, source.name, ctx.signal, excerpts);
            const results = (await source.search(query, { maxResults: n, signal: ctx.signal, get, maxChars })).slice(0, n);
            return JSON.stringify({ untrusted: true, note: UNTRUSTED_NOTE, source: source.name, query, retrieved_at: new Date().toISOString(), results });
          });
        } catch (err) {
          if (ctx.signal.aborted) throw err;
          return { content: `${source.tool} failed: ${errorMessage(err)}`, isError: true };
        }
      },
    });
  }
  return out;
}
