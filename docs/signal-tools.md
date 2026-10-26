# Public signal tools

Research tools over public APIs that need no key: what people discuss, build, ask and publish about a topic.
They complement [web tools](web-tools.md): structured counts (points, stars, answers, dates) instead of page text.

| Tool | Source | Result fields |
|---|---|---|
| `search_discussions` | Hacker News stories via the Algolia HN API | `title`, `url`, `points`, `comments`, `created_at`, `hn_url` |
| `search_projects` | GitHub repository search, sorted by stars (optional issues search) | `name`, `url`, `stars`, `open_issues`, `pushed_at`, `description` (truncated); issues: `kind: "issue"`, `title`, `url`, `state`, `comments`, `updated_at`, `repo` |
| `search_questions` | Stack Exchange `search/advanced` on Stack Overflow, by relevance | `title`, `url`, `score`, `answer_count`, `is_answered`, `creation_date` |
| `search_papers` | arXiv API (Atom, parsed without dependencies) | `title`, `url`, `published`, `authors` (first 3), `more_authors` |

All tools take `{ query, max_results? }`, have risk `read`, and return compact JSON:

```json
{ "untrusted": true, "note": "External web content: ...", "source": "hackernews", "query": "...",
  "retrieved_at": "2026-10-26T10:00:00.000Z", "results": [ ... ] }
```

Titles and descriptions are written by third parties: treat them as data, never as instructions (same rules as
[web tools](web-tools.md#security-prompt-injection-and-exfiltration)).

## In code

```ts
import { agent, signalTools } from 'reinloop';

const signals = signalTools({ sources: ['hackernews', 'github', 'arxiv'], maxResults: 5, cacheTtlMs: 10 * 60_000 });
const scout = agent({ model: 'anthropic/claude-haiku-5-5', tools: Object.values(signals), budget: { maxToolCalls: 8 } });
```

Options: `sources` (built-in names or `SignalSource` objects, default all four), `maxResults` (default 5),
`maxResultsCap` (default 10), `maxChars` per free-text field (default 300), `cacheTtlMs` (default 0: off),
`timeoutMs` per request (default 10000), `githubToken` (default env `GITHUB_TOKEN`), `githubIssues` (default false),
`stackExchangeSite` (default `stackoverflow`), `userAgent`, `env`, `fetchImpl`.

Each call counts against the run's `maxToolCalls` like any tool; set it to bound how much an agent queries per run.
Failures (rate limits, timeouts, HTTP errors) come back as tool errors (`search_projects failed: github rate limit
reached: resets at ...`) so the model can try another source instead of the run failing.

## Config

```json
{
  "signals": { "sources": ["hackernews", "github", "stackoverflow", "arxiv"], "maxResults": 5, "cacheTtlMs": 600000,
               "githubToken": "${env:GITHUB_TOKEN}" },
  "agents": { "scout": { "model": "anthropic/claude-haiku-5-5", "tools": ["search_discussions", "search_projects", "search_papers"] } }
}
```

Listing a tool whose source is not in `signals.sources` is a configuration error.

## Custom sources

```ts
import { signalTools, type SignalSource } from 'reinloop';

const lobsters: SignalSource = {
  name: 'lobsters',
  tool: 'search_lobsters',
  description: 'Search Lobsters stories (untrusted external content).',
  async search(query, { maxResults, get }) {
    const items = await get(`https://lobste.rs/search.json?q=${encodeURIComponent(query)}&what=stories`);
    return items.slice(0, maxResults).map((s: any) => ({ title: s.title, url: s.url, score: s.score }));
  },
};
const tools = signalTools({ sources: ['hackernews', lobsters] });
```

`get(url, { headers?, as?: 'json' | 'text' })` applies the timeout, User-Agent, cancellation and rate-limit handling.
Throw `SignalRateLimitError` from a source for upstream quota errors in a response body.

## Rate limits and terms of use

Check each provider's terms before heavy or commercial use; the tools send a descriptive User-Agent
(`reinloop/<version> (+repo url)`, override with `userAgent`) and one request per call (two for GitHub with
`githubIssues`). Enable `cacheTtlMs` to avoid repeating identical queries.

- **Hacker News (Algolia):** public, no key; about 10,000 requests per hour per IP.
- **GitHub:** search API allows 10 requests/minute unauthenticated, 30/minute with a token. The token (option or
  env `GITHUB_TOKEN`) is sent only to `api.github.com`; a read-only token with no scopes is enough. When
  `x-ratelimit-remaining` is 0 the tool returns the reset time.
- **Stack Exchange:** 300 requests/day per IP without an app key; throttling (`throttle_violation`, HTTP 429) and an
  exhausted quota become rate-limit errors. Content is CC BY-SA: attribute when you reuse it.
- **arXiv:** asks for at most one request every 3 seconds and a single connection; use the cache and modest budgets.
  Metadata is free to reuse; paper licenses vary.

Example (offline, stub fetch): `node examples/signal-research.ts`.
