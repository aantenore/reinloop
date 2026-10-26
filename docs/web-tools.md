# Web tools and provider-hosted tools

Two ways to give an agent the web:

| | Built-in `web_search` / `web_fetch` | Provider-hosted tools |
|---|---|---|
| Who runs the call | reinloop, through a search backend (Tavily, Anthropic, your own) | The model provider, inside the model turn |
| Models | Any | Anthropic only (Chat Completions providers reject them) |
| Policy | Per call, like any tool (`risk: read`) | Once per run, before the tool is offered |
| Cost | Backend billing, outside the run's cost | Tokens plus per-request price in `costUsd` |

## Built-in web tools

```json
{
  "web": { "provider": "tavily", "maxResults": 5, "cacheTtlMs": 300000 },
  "agents": { "researcher": { "tools": ["web_search", "web_fetch"] } }
}
```

In an agent file: `tools: [web_search, web_fetch]`.

- `web_search {query, max_results?}` returns `{ untrusted, note, query, results: [{ title, url, snippet, published? }] }`.
- `web_fetch {url}` (http/https only) returns `{ untrusted, note, url, title?, content, truncated?, totalChars? }`.
- Both have risk `read` and count against `maxToolCalls`.

`web` options: `provider` (`tavily` default, or `anthropic-native`), `apiKey` (default env `TAVILY_API_KEY`;
`${env:...}` works), `searchDepth`, `topic`, `includeDomains` / `excludeDomains`, `maxResults` (default 5),
`maxResultsCap` (default 10), `maxChars` per snippet (default 1000), `maxFetchChars` (default 8000), `cacheTtlMs`
(default 0: off). `anthropic-native` runs one small model call with the hosted search (`model`, default
`anthropic/claude-haiku-5-5`; `maxUses`): search only, no `web_fetch`, and its tokens are not part of the calling
run's usage. To have searches priced in the run, use the hosted tool directly (below).

In code:

```ts
import { agent, webTools, type WebProvider } from 'reinloop';

const { web_search, web_fetch } = webTools({ provider: 'tavily', maxResults: 5 });

// Your own backend (SearXNG, Brave, an internal index...): fetch is optional.
const mine: WebProvider = {
  name: 'intranet',
  search: async (query, { maxResults, signal }) => [{ title: 'Doc', url: 'https://intra/doc', content: '...' }],
};
const intranet = webTools({ provider: mine }).web_search;
```

A plugin can replace the built-in tools by registering its own under the same names
(`registry.tool(webTools({ provider: mine }).web_search)`).

## Provider-hosted tools

```ts
import { agent, hostedTool } from 'reinloop';

const search = hostedTool({
  provider: 'anthropic',
  type: 'web_search_20250305', // web_search_20260209 on models that support dynamic filtering
  params: { max_uses: 5, allowed_domains: ['modelcontextprotocol.io'] },
});
const researcher = agent({ model: 'anthropic/claude-sonnet-5-5', tools: [search] });
```

Or in config, referenced by name from `tools`:

```json
{
  "hostedTools": {
    "web_search": { "provider": "anthropic", "type": "web_search_20250305", "params": { "max_uses": 5 } },
    "code_execution": { "provider": "anthropic", "type": "code_execution_20260521" }
  },
  "policy": { "rules": [{ "match": "code_execution", "action": "allow" }] },
  "agents": { "analyst": { "model": "sonnet", "tools": ["web_search", "code_execution"] } }
}
```

- `params` are sent verbatim with the tool (`max_uses`, `allowed_domains`, `blocked_domains`, `user_location`,
  `max_content_tokens`, ...). `name` defaults to the type without its date suffix. `beta` adds an `anthropic-beta`
  flag for tool versions that need one.
- Calls and results are kept in the history as `hosted_call` / `hosted_result` parts and echoed unchanged on the
  next request, so multi-turn conversations, thinking blocks, streaming and structured output keep working. Text
  citations stay on text parts (`citations`). A `pause_turn` stop is resumed automatically.
- Events: `hosted_tool_start { callId, name, input }` and `hosted_tool_result { callId, name, summary, isError,
  sources? }` (streamed to sinks, not persisted: the same data is in `model_response`).
- Budget: every hosted call counts against `maxToolCalls`; `max_uses` of web search/fetch is lowered to what is left.
- Cost: `usage.serverToolUse` counts billed requests (`webSearchRequests`, ...). Built-in Claude prices charge
  $0.01 per search; set `pricing.<model>.serverToolUsd` to change it. Code execution container time is not priced.
- Policy: applied once per run before the tool is offered; a denied tool is not sent. Web search/fetch default to
  risk `read` (allowed); other types default to `exec` (asked, so dropped without an approver). Middleware
  `beforeTool` / `afterTool` hooks do not see hosted calls: the provider runs them.

## Security: prompt injection

Web pages are written by strangers. Anything a search or fetch returns can contain text that tries to steer the model
("ignore previous instructions", fake tool output, links to exfiltrate data to). reinloop marks built-in results with
`untrusted: true` and a note, but a marker is not a defence on its own:

- keep write and exec tools behind approval (the default) in agents that read the web;
- prefer a separate research agent with only read tools, delegated to by the agent that acts;
- restrict domains (`includeDomains`, `allowed_domains`) when the sources are known;
- set `maxToolCalls` and `maxCostUsd` budgets.

Example (offline): `node examples/web-research.ts`.
