import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { anthropicWebProvider, createRuntime, mockProvider, tavilyProvider, webTools, type ToolContext, type WebProvider } from '../src/index.ts';
import { fakeFetch, json } from './helpers.ts';

const ctx = { signal: new AbortController().signal } as ToolContext;
const call = async (tool: any, args: unknown) => {
  const out = await tool.run(args, ctx);
  return typeof out === 'string' ? JSON.parse(out) : out;
};

describe('tavily provider', () => {
  it('sends the search and extract request shapes', async () => {
    const f = fakeFetch([
      json({ results: [{ title: 'T', url: 'https://a.example', content: 'x'.repeat(50), score: 0.9, published_date: '2026-01-02' }] }),
      json({ results: [{ url: 'https://a.example', raw_content: 'page body' }], failed_results: [] }),
    ]);
    const tools = webTools({
      provider: 'tavily',
      tavily: { apiKey: 'tvly-test', fetch: f.impl, searchDepth: 'advanced', includeDomains: ['a.example'], excludeDomains: ['b.example'] },
      maxChars: 20,
    });
    const search = await call(tools.web_search, { query: 'mcp security', max_results: 3 });
    const { url, body, headers } = f.requests[0]!;
    assert.equal(url, 'https://api.tavily.com/search');
    assert.equal(headers.authorization, 'Bearer tvly-test');
    assert.deepEqual(body, {
      query: 'mcp security', max_results: 3, search_depth: 'advanced', include_domains: ['a.example'], exclude_domains: ['b.example'],
      include_answer: false, include_raw_content: false,
    });
    assert.equal(search.untrusted, true);
    assert.match(search.note, /untrusted/);
    assert.equal(search.results[0].snippet, `${'x'.repeat(20)}…`);
    assert.equal(search.results[0].published, '2026-01-02');

    const page = await call(tools.web_fetch, { url: 'https://a.example' });
    assert.equal(f.requests[1]!.url, 'https://api.tavily.com/extract');
    assert.deepEqual(f.requests[1]!.body, { urls: ['https://a.example'], extract_depth: 'basic', format: 'markdown' });
    assert.deepEqual(page, { untrusted: true, note: page.note, url: 'https://a.example', content: 'page body' });
  });

  it('reads the key from env and fails fast without one', () => {
    assert.throws(() => tavilyProvider({ env: {} }), /TAVILY_API_KEY/);
    assert.equal(tavilyProvider({ env: { TAVILY_API_KEY: 'k' } }).name, 'tavily');
  });
});

describe('webTools', () => {
  const stub = (pages = 'p'.repeat(100)) => {
    const calls = { search: 0, fetch: 0 };
    const provider: WebProvider = {
      name: 'stub',
      async search(query, { maxResults }) {
        calls.search++;
        return Array.from({ length: 20 }, (_, i) => ({ title: `${query} ${i}`, url: `https://s.example/${i}`, content: 'c' }));
      },
      async fetch(url) {
        calls.fetch++;
        return { url, title: 'Page', content: pages };
      },
    };
    return { provider, calls };
  };

  it('truncates, limits results and caches within the TTL', async () => {
    const { provider, calls } = stub();
    const tools = webTools({ provider, maxResults: 2, maxFetchChars: 10, cacheTtlMs: 60_000 });
    const a = await call(tools.web_search, { query: 'q' });
    const b = await call(tools.web_search, { query: 'q' });
    assert.equal(a.results.length, 2);
    assert.deepEqual(a, b);
    assert.equal(calls.search, 1);
    const page = await call(tools.web_fetch, { url: 'https://s.example/1' });
    assert.equal(page.content, `${'p'.repeat(10)}…`);
    assert.equal(page.truncated, true);
    assert.equal(page.totalChars, 100);
    await call(tools.web_fetch, { url: 'https://s.example/1' });
    assert.equal(calls.fetch, 1);
  });

  it('does not cache by default and rejects non-http URLs', async () => {
    const { provider, calls } = stub();
    const tools = webTools({ provider });
    await call(tools.web_search, { query: 'q' });
    await call(tools.web_search, { query: 'q' });
    assert.equal(calls.search, 2);
    const bad = await call(tools.web_fetch, { url: 'file:///etc/passwd' });
    assert.equal(bad.isError, true);
    assert.equal(tools.web_search.risk, 'read');
    assert.equal(tools.web_fetch!.risk, 'read');
  });

  it('omits web_fetch when the provider cannot fetch', () => {
    const tools = webTools({ provider: { name: 'search-only', search: async () => [] } });
    assert.equal(tools.web_fetch, undefined);
  });

  it('anthropic-native maps hosted sources and citations into results', async () => {
    const provider = mockProvider([
      {
        parts: [
          { type: 'hosted_call', id: 's1', name: 'web_search', input: { query: 'q' } },
          { type: 'hosted_result', callId: 's1', name: 'web_search', blockType: 'web_search_tool_result', content: [], sources: [{ url: 'https://n.example', title: 'N' }] },
          { type: 'text', text: 'answer', citations: [{ type: 'web_search_result_location', url: 'https://n.example', cited_text: 'quoted' }] },
        ],
      },
    ]);
    const tools = webTools({ provider: 'anthropic-native', anthropic: { model: { provider, model: 'claude-haiku-5-5' }, maxUses: 2 } });
    const out = await call(tools.web_search, { query: 'q' });
    assert.deepEqual(out.results, [{ title: 'N', url: 'https://n.example', snippet: 'quoted' }]);
    assert.equal(provider.requests[0]!.tools[0]!.hosted?.params?.max_uses, 2);
    assert.equal(anthropicWebProvider({ model: { provider, model: 'x' } }).fetch, undefined);
  });

  it('is configured through the web config section', async () => {
    const rt = await createRuntime(
      { web: { provider: 'tavily', apiKey: '${env:MY_TAVILY}', maxResults: 3 }, agents: { a: { model: 'mock/x', tools: ['web_*'] } } },
      { env: { MY_TAVILY: 'k' } },
    );
    const a = (await rt.agent('a')) as any;
    assert.deepEqual(a.tools.map((t: any) => t.name).sort(), ['web_fetch', 'web_search']);
  });
});
