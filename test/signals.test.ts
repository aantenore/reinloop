import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRuntime, parseArxivAtom, signalTools, type SignalSource, type ToolContext } from '../src/index.ts';

const ctx = { signal: new AbortController().signal, runId: 'r1' } as ToolContext;
const call = async (tool: any, args: unknown) => {
  const out = await tool.run(args, ctx);
  return typeof out === 'string' ? JSON.parse(out) : out;
};

/** GET stub: records URL + headers, answers from a queue. */
function stubFetch(responses: Array<() => Response>) {
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];
  const impl = async (url: string, init: RequestInit) => {
    requests.push({ url, headers: init.headers as Record<string, string> });
    const next = responses.shift();
    if (!next) throw new Error('no more fake responses');
    return next();
  };
  return { impl, requests };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const text = (body: string, status = 200) => () => new Response(body, { status, headers: { 'content-type': 'application/atom+xml' } });

const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <title type="html">ArXiv Query</title>
  <entry>
    <id>http://arxiv.org/abs/2501.00001v1</id>
    <published>2025-01-01T00:00:00Z</published>
    <title>Securing MCP Servers:
      A &amp; B</title>
    <summary>Long abstract</summary>
    <author><name>Ada One</name></author>
    <author><name>Bo Two</name><arxiv:affiliation>X</arxiv:affiliation></author>
    <author><name>Cy Three</name></author>
    <author><name>Di Four</name></author>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2502.00002v2</id>
    <published>2025-02-02T00:00:00Z</published>
    <title>Second</title>
    <author><name>Solo</name></author>
  </entry>
</feed>`;

describe('signalTools', () => {
  it('hackernews: request shape, parsing, untrusted marker', async () => {
    const f = stubFetch([json({ hits: [{ objectID: '42', title: 'MCP &amp; security', url: 'https://x.example/a', points: 10, num_comments: 3, created_at: '2026-01-01T00:00:00Z' }, { objectID: '43', title: 'Ask HN' }] })]);
    const tools = signalTools({ sources: ['hackernews'], fetchImpl: f.impl });
    assert.deepEqual(Object.keys(tools), ['search_discussions']);
    const out = await call(tools.search_discussions, { query: 'MCP server security', max_results: 2 });
    const u = new URL(f.requests[0]!.url);
    assert.equal(u.origin + u.pathname, 'https://hn.algolia.com/api/v1/search');
    assert.equal(u.searchParams.get('query'), 'MCP server security');
    assert.equal(u.searchParams.get('tags'), 'story');
    assert.equal(u.searchParams.get('hitsPerPage'), '2');
    assert.match(f.requests[0]!.headers['user-agent']!, /^reinloop\//);
    assert.equal(out.untrusted, true);
    assert.match(out.note, /untrusted/);
    assert.equal(out.source, 'hackernews');
    assert.ok(!Number.isNaN(Date.parse(out.retrieved_at)));
    assert.deepEqual(out.results[0], { title: 'MCP & security', url: 'https://x.example/a', points: 10, comments: 3, created_at: '2026-01-01T00:00:00Z', hn_url: 'https://news.ycombinator.com/item?id=42' });
    assert.equal(out.results[1].url, 'https://news.ycombinator.com/item?id=43');
  });

  it('github: request shape, token, truncation, issues', async () => {
    const f = stubFetch([
      json({ items: [{ full_name: 'a/b', html_url: 'https://github.com/a/b', stargazers_count: 5, open_issues_count: 1, pushed_at: '2026-02-01T00:00:00Z', description: 'd'.repeat(50) }] }),
      json({ items: [{ title: 'Bug', html_url: 'https://github.com/a/b/issues/1', state: 'open', comments: 2, updated_at: 'x', repository_url: 'https://api.github.com/repos/a/b' }] }),
    ]);
    const tools = signalTools({ sources: ['github'], fetchImpl: f.impl, githubToken: 'ghp_test', githubIssues: true, maxChars: 20 });
    const out = await call(tools.search_projects, { query: 'mcp' });
    const u = new URL(f.requests[0]!.url);
    assert.equal(u.pathname, '/search/repositories');
    assert.equal(u.searchParams.get('q'), 'mcp');
    assert.equal(u.searchParams.get('sort'), 'stars');
    assert.equal(u.searchParams.get('per_page'), '5');
    assert.equal(f.requests[0]!.headers.authorization, 'Bearer ghp_test');
    assert.equal(new URL(f.requests[1]!.url).searchParams.get('q'), 'mcp is:issue');
    assert.equal(out.results[0].description, `${'d'.repeat(20)}…`);
    assert.equal(out.results[0].stars, 5);
    assert.deepEqual(out.results[1], { kind: 'issue', title: 'Bug', url: 'https://github.com/a/b/issues/1', state: 'open', comments: 2, updated_at: 'x', repo: 'a/b' });
  });

  it('github: token from env, no auth header without one', async () => {
    const f = stubFetch([json({ items: [] }), json({ items: [] })]);
    await call(signalTools({ sources: ['github'], fetchImpl: f.impl, env: { GITHUB_TOKEN: 'from-env' } }).search_projects, { query: 'q' });
    await call(signalTools({ sources: ['github'], fetchImpl: f.impl, env: {} }).search_projects, { query: 'q' });
    assert.equal(f.requests[0]!.headers.authorization, 'Bearer from-env');
    assert.equal(f.requests[1]!.headers.authorization, undefined);
  });

  it('github: rate limit becomes a clear tool error', async () => {
    const f = stubFetch([json({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '10', 'x-ratelimit-reset': '1800000000' })]);
    const out = await call(signalTools({ sources: ['github'], fetchImpl: f.impl, env: {} }).search_projects, { query: 'q' });
    assert.equal(out.isError, true);
    assert.match(out.content, /github rate limit reached: resets at 2027-01-15T08:00:00.000Z \(set GITHUB_TOKEN/);
  });

  it('stackoverflow: request shape, parsing, throttle error', async () => {
    const f = stubFetch([
      json({ items: [{ title: 'How to &quot;secure&quot;?', link: 'https://stackoverflow.com/q/1', score: 4, answer_count: 2, is_answered: true, creation_date: 1700000000 }], quota_remaining: 290 }),
      json({ error_id: 502, error_name: 'throttle_violation', error_message: 'too many requests' }, 400),
      json({}, 429, { 'retry-after': '30' }),
    ]);
    const tools = signalTools({ sources: ['stackoverflow'], fetchImpl: f.impl });
    const out = await call(tools.search_questions, { query: 'mcp security', max_results: 3 });
    const u = new URL(f.requests[0]!.url);
    assert.equal(u.origin + u.pathname, 'https://api.stackexchange.com/2.3/search/advanced');
    for (const [k, v] of Object.entries({ order: 'desc', sort: 'relevance', q: 'mcp security', site: 'stackoverflow', pagesize: '3' })) assert.equal(u.searchParams.get(k), v);
    assert.deepEqual(out.results[0], { title: 'How to "secure"?', url: 'https://stackoverflow.com/q/1', score: 4, answer_count: 2, is_answered: true, creation_date: '2023-11-14T22:13:20.000Z' });
    assert.equal(out.source, 'stackoverflow');
    const err = await call(tools.search_questions, { query: 'other' });
    assert.equal(err.isError, true);
    assert.match(err.content, /stackoverflow rate limit reached: .*too many requests/);
    const limited = await call(tools.search_questions, { query: 'third' });
    assert.match(limited.content, /stackoverflow rate limit reached: retry after 30s/);
  });

  it('stackoverflow: throttle in a 200 body is a rate-limit error', async () => {
    const f = stubFetch([json({ error_id: 502, error_name: 'throttle_violation', error_message: 'slow down' })]);
    const out = await call(signalTools({ sources: ['stackoverflow'], fetchImpl: f.impl }).search_questions, { query: 'q' });
    assert.match(out.content, /rate limit reached: slow down/);
  });

  it('arxiv: request shape and Atom parsing', async () => {
    const f = stubFetch([text(ATOM)]);
    const out = await call(signalTools({ sources: ['arxiv'], fetchImpl: f.impl }).search_papers, { query: 'MCP server "security"', max_results: 2 });
    const u = new URL(f.requests[0]!.url);
    assert.equal(u.origin + u.pathname, 'https://export.arxiv.org/api/query');
    assert.equal(u.searchParams.get('search_query'), 'all:MCP AND all:server AND all:security');
    assert.equal(u.searchParams.get('max_results'), '2');
    assert.deepEqual(out.results, [
      { title: 'Securing MCP Servers: A & B', url: 'https://arxiv.org/abs/2501.00001v1', published: '2025-01-01T00:00:00Z', authors: ['Ada One', 'Bo Two', 'Cy Three'], more_authors: 1 },
      { title: 'Second', url: 'https://arxiv.org/abs/2502.00002v2', published: '2025-02-02T00:00:00Z', authors: ['Solo'] },
    ]);
    assert.deepEqual(parseArxivAtom('<feed></feed>'), []);
  });

  it('caches per query, caps max_results, maps timeouts and network errors', async () => {
    let calls = 0;
    const custom: SignalSource = {
      name: 'stub',
      tool: 'search_stub',
      description: 'stub',
      async search(query, { maxResults }) {
        calls++;
        return Array.from({ length: 30 }, (_, i) => ({ title: `${query} ${i}` })).slice(0, maxResults + 5);
      },
    };
    const tools = signalTools({ sources: [custom], cacheTtlMs: 60_000, maxResultsCap: 4 });
    const a = await call(tools.search_stub, { query: 'x', max_results: 50 });
    await call(tools.search_stub, { query: 'x', max_results: 50 });
    assert.equal(a.results.length, 4);
    assert.equal(calls, 1);

    const hang = async (_u: string, init: RequestInit) => new Promise<Response>((_, rej) => init.signal!.addEventListener('abort', () => rej(new Error('aborted'))));
    const t = await call(signalTools({ sources: ['hackernews'], fetchImpl: hang, timeoutMs: 20 }).search_discussions, { query: 'q' });
    assert.match(t.content, /hackernews: request timed out after 20 ms/);
    const down = await call(signalTools({ sources: ['hackernews'], fetchImpl: async () => { throw new Error('ECONNREFUSED'); } }).search_discussions, { query: 'q' });
    assert.match(down.content, /network error: ECONNREFUSED/);
  });

  it('rejects unknown and duplicate sources', () => {
    assert.throws(() => signalTools({ sources: ['nope' as any] }), /unknown signal source/);
    assert.throws(() => signalTools({ sources: ['arxiv', 'arxiv'] }), /two signal sources/);
  });

  it('is configurable through the runtime config', async () => {
    const rt = await createRuntime(
      { signals: { sources: ['hackernews', 'arxiv'], maxResults: 3 }, agents: { a: { model: 'mock/x', tools: ['search_discussions', 'search_papers'] }, b: { model: 'mock/x', tools: ['search_projects'] } } },
      { env: {} },
    );
    const a = (await rt.agent('a')) as any;
    assert.deepEqual(a.tools.map((t: any) => t.name).sort(), ['search_discussions', 'search_papers']);
    await assert.rejects(rt.agent('b'), /search_projects is not available/);
  });
});
