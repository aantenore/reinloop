# Configuration

Configuration is optional. Agent files cover most needs; `reinloop.json` adds shared settings (providers, policy,
storage, caching, observability) and can define agents and teams in JSON. Every `type` is a factory name in the
registry, so plugins can add their own. Editors get completion from `schema/reinloop.schema.json`.

```json
{
  "$schema": "./node_modules/reinloop/schema/reinloop.schema.json",
  "extends": "./base.json",
  "plugins": ["./plugins/redact-secrets.mjs"],
  "defaultAgent": "ship",
  "defaultModel": "${env:REINLOOP_MODEL:-anthropic/claude-sonnet-5-5}",
  "agentsDir": ["agents", "shared/agents"],
  "skillsDir": ["skills", "~/team-skills"],

  "providers": {
    "corp": { "type": "openai-compatible", "baseUrl": "https://llm.internal/v1", "apiKey": "${env:CORP_KEY}", "stream": true, "retry": { "maxAttempts": 4 } }
  },
  "presets": { "anthropic": { "headers": { "x-client-team": "platform" } } },
  "pricing": { "claude-sonnet-5-5": { "inputPerMTok": 1.8 } },
  "models": {
    "fast": { "provider": "corp", "model": "llama-4-70b", "fallback": ["smart"] },
    "smart": { "provider": "corp", "model": "big-model", "pricing": { "inputPerMTok": 3, "outputPerMTok": 15, "cacheReadPerMTok": 0.3 } }
  },

  "mcpServers": {
    "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."], "exclude": ["write_*"] },
    "docs": { "url": "https://mcp.example.com/mcp", "headers": { "authorization": "Bearer ${env:DOCS_TOKEN}" }, "risk": "read" },
    "tools": { "url": "https://tools.example.com/mcp", "auth": { "audience": "tools-api", "scopes": ["tools.read"] } }
  },

  "httpTools": {
    "get_user": { "description": "Fetch a user", "method": "GET", "url": "https://api.example.com/users/{id}", "schema": { "properties": { "id": { "type": "string" } }, "required": ["id"] }, "risk": "read", "auth": { "audience": "users-api" } }
  },
  "openapi": { "petstore": { "spec": "./petstore.json", "baseUrl": "https://petstore.example/v1", "include": ["get*", "list*"], "auth": { "audience": "petstore" } } },

  "tools": { "workspace": ".", "concurrency": 8, "timeoutMs": 120000, "maxResultChars": 32000, "artifacts": "file", "shellTimeoutMs": 120000 },
  "policy": {
    "risk": { "write": "allow" },
    "rules": [{ "match": "shell", "action": "ask" }, { "match": "fs__*", "risk": "exec", "action": "deny" }, { "match": "docs__*", "action": "allow", "when": { "roles": ["analyst"], "kind": "user" } }],
    "pdp": { "type": "opa", "url": "${env:OPA_URL}", "path": "agents/allow", "onError": "deny" }
  },
  "identity": {
    "verifier": { "issuer": "${env:OIDC_ISSUER}", "audience": "agent-api" },
    "credentials": { "issuer": "${env:OIDC_ISSUER}", "clientId": "${env:OIDC_CLIENT_ID}", "clientSecret": "${env:OIDC_CLIENT_SECRET}", "mode": "on-behalf-of" },
    "required": true
  },
  "knowledge": {
    "k": 4, "mode": "first-turn",
    "sources": { "docs": { "type": "mcp", "server": "qdrant", "tool": "qdrant-find" }, "wiki": { "type": "wiki", "dir": "wiki" } }
  },
  "guardrails": { "onError": "block", "guards": [{ "type": "regex", "action": "redact", "patterns": ["secret"] }] },
  "routers": { "by-size": { "type": "rule", "rules": [{ "when": { "minEstTokens": 6000 }, "model": "smart" }], "default": "fast" } },

  "store": { "type": "file", "dir": ".reinloop/runs" },
  "responseCache": { "type": "file", "dir": ".reinloop/cache", "ttlMs": 86400000, "namespace": "v1" },
  "memory": { "type": "file", "dir": ".reinloop/memory", "scope": "shared" },
  "sinks": [{ "type": "console", "level": "info" }, { "type": "jsonl", "dir": ".reinloop/traces" }],

  "agents": { "coder": { "model": "fast", "router": "by-size", "middleware": ["knowledge", "guard"], "instructions": "file:./prompts/coder.md", "tools": ["read_file", "edit_file", "shell", "fs__*"] } },
  "teams": { "ship": { "pattern": "evaluator", "roles": { "generator": "coder", "evaluator": "reviewer" } } },

  "profiles": { "ci": { "defaultModel": "mock/echo", "responseCache": { "type": "memory" } } }
}
```

## Layering

1. `extends` (string or list), resolved relative to the file. Objects merge deeply; arrays replace.
2. The file itself.
3. Agent files from `agentsDir` (default `agents/` and `.reinloop/agents/`). A name defined twice is an error.
4. Profile overlay: `--profile <name>` or `REINLOOP_PROFILE`.

Strings may use `${env:NAME}` or `${env:NAME:-default}`. A missing variable is an error only when the component that
needs it is built, so an unused provider never blocks a run. Numeric limits take placeholders too (see [Limits](#limits)).

## Sections

| Section | Notes |
|---|---|
| `providers.<name>` | `type`: `openai-compatible` (`baseUrl`, `apiKey`, `headers`, `stream`, `maxTokensParam`, `structuredOutput: true \| false \| "without-tools"`), `anthropic` (`baseUrl`, `apiKey`, `version`, `headers`, `stream`, `cache` (default on: breakpoints on tools, system prompt and the latest message; agents override with `params.cache` / `params.cacheTtl: "5m" \| "1h"`), `cacheTtl`, `cacheMinTokens` (default 1024: shorter prefixes get no breakpoint), `defaultMaxTokens`, `structuredOutput`), `mock` (`responses`, `loop`), or a plugin type. `retry: false \| { maxAttempts, baseDelayMs, maxDelayMs, retryOn }` (retries are on by default), `errorBodyChars`, `responseExcerptChars`. A provider named `x` makes `x/<model>` strings work. |
| `presets.<name>` | Settings for a built-in preset used as `"<name>/<model>"`: `headers` (extra request headers, `${env:...}` allowed). Ignored when `providers.<name>` defines a provider with the same name. Presets also read headers from env vars: `ANTHROPIC_WORKSPACE_ID` becomes `anthropic-workspace-id` for `anthropic/...`; config headers win over env ones. |
| `models.<alias>` | `provider`, `model`, `params`, `pricing` (USD per million tokens, used for cost budgets), `fallback` (aliases tried in order). |
| `pricing.<model id>` | Price overrides (`inputPerMTok`, `outputPerMTok`, `cacheReadPerMTok`, USD per million tokens; `cacheWriteMultiplier` / `cacheWrite1hMultiplier`, cache writes as a multiple of the input price, built in for Claude as 1.25 / 2; `serverToolUsd`, USD per hosted-tool request such as `{ "webSearchRequests": 0.01 }`) keyed by the model id without the provider prefix, merged field by field over the built-in table (`PRICING`: `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`). `models.<alias>.pricing` takes precedence. Models without a price cost 0, so `maxCostUsd` does not limit them. |
| `mcpServers.<name>` | stdio (`command`, `args`, `env`, `cwd`) or HTTP (`url`, `headers`); `prefix`, `include`/`exclude` globs, `risk` (otherwise derived from tool annotations), `readOnly` (globs of tool names treated as `read`), `timeoutMs`, `errorBodyChars`, `stderrChars`, `auth: { audience, scopes? }` (streamable HTTP only: every call carries a token for that audience from the run's credentials, see [layers/identity.md](layers/identity.md#mcp-streamable-http)). Tools appear as `<prefix>__<tool>` (prefix defaults to the server name); `prefix: false` (or `""`) keeps the server's own names, and agents then select them with `mcp:<name>` (narrow with `include`). |
| `httpTools.<name>` | Declarative HTTP tool: `description`, `method`, `url` (with `{param}`), `schema` (`properties`, `required`), `query`, `headerArgs`, `headers`, `body: json \| none`, `bodyArg`, `risk`, `timeoutMs`, `maxResultChars`, `errorBodyChars`, `auth: { audience, scopes? }`. See [layers/tool.md](layers/tool.md). |
| `openapi.<name>` | Tools generated from an OpenAPI 3 JSON document, one per operation: `spec` (path or URL), `baseUrl`, `include` (globs over `operationId`), `headers`, `timeoutMs`, `maxResultChars`, `errorBodyChars`, `specTimeoutMs`, `maxRefDepth`, `descriptionChars`, `auth: { audience, scopes? }`. Tool names are prefixed with `<name>__`. See [layers/tool.md](layers/tool.md). |
| `tools` | Workspace root and execution limits (`concurrency`, `timeoutMs`, `maxResultChars`, `shellTimeoutMs`, `shellMaxOutputChars`, `shellExitGraceMs`, `maxWalkFiles`, `maxFindResults`, `searchMaxResults`, `searchMaxFileBytes`, `searchLineChars`, `artifactReadChars`, `skillMaxFileBytes`, `skillDescriptionChars`; see [Limits](#tools)); `artifacts: none \| memory \| file` enables offloading when an agent lists `read_artifact`. |
| `policy` | Global rules, evaluated after each agent's own rules. `default`, `risk.<read\|write\|exec>` and `rules[]` (`match` glob, `risk`, `action: allow \| ask \| deny`, `reason`, `when: { roles, scopes, kind }`; `roles` and `scopes` match any-of, `kind` is `user` or `agent`, and a rule with `when` never matches a run without identity). Unlabelled tools (your functions) are allowed by default; `read` is allowed, while `write` and `exec` ask. With no approver, "ask" means deny. |
| `policy.pdp` | External policy decision point asked after the local rules (a local `deny` is final): `type` (`opa`, `authzen`, or a plugin), `url`, `path` (OPA), `headers`, `includeArgs` (send tool arguments; off by default), `onError: allow \| ask \| deny` (default `deny`), `timeoutMs`, `maxResponseBytes`, `errorBodyChars`, `maxReasonChars`. See [layers/identity.md](layers/identity.md#external-pdp). |
| `identity` | `verifier` (turns a bearer token into the run identity) and `credentials` (outbound tokens: `mode: on-behalf-of \| self`), each with `type` (default `oidc`) plus the factory's own fields (`issuer`, `audience`, `clientId`, `clientSecret`, and the limits under [Identity](#identity)); `required` (default true): `reinloop serve` rejects `/v1/*` calls without a valid token. See [layers/identity.md](layers/identity.md). |
| `knowledge` | Retrieval sources and auto-retrieval settings: `sources.<name>` with `type: mcp \| http \| wiki` (`mcp`: `server` or `command`/`args`/`env`/`cwd` or `url`/`headers`, `tool`, `queryArg`, `toolArgs`; `http`: `url`, `headers`; `wiki`: `dir`, `maxPassageChars`; `http`, `mcp`: `timeoutMs`, `errorBodyChars`), `k`, `maxK`, `maxChars`, `toolMaxChars`, `mode: first-turn \| every-turn` (default `first-turn`), `timeoutMs`, `maxQueryChars`, `maxTrackedRuns`. Agents enable it with `tools: [search_knowledge]` and/or `middleware: [knowledge]`. See [layers/knowledge.md](layers/knowledge.md). |
| `guardrails` | `guards[]` (each with `type`: `regex`, `presidio`, `llm-guard`, `http`, or a plugin, plus its options), `onError: block \| allow` (default `block`, fail closed), `name`, `maxReasonChars`. Agents opt in with `middleware: [guard]`. See [layers/guardrail.md](layers/guardrail.md). |
| `routers.<name>` | Model routers (`type: rule` with `rules[]` of `when: { minEstTokens, maxEstTokens, hasTools, turnAtLeast }` and `model`, plus `default`; or a plugin type). Agents attach one with `router: <name>`. See [layers/cache.md](layers/cache.md). |
| `store` | `memory` or `file`: the event log used for sessions and resume. |
| `responseCache` | `memory` or `file` (+ `ttlMs`, `namespace`; `memory`: `maxEntries`): identical requests replay at zero cost. Agents opt out with `responseCache: false`. |
| `memory` | Backing store for `remember` / `recall`; `scope: shared \| agent`, `recallLimit`. |
| `hostedTools.<name>` | Provider-hosted tools (`provider`, `type`, `params`, `risk`, `description`, `limitParam` (name of the `params` field that receives the remaining tool-call budget, e.g. `max_uses`), `beta`) that agents list in `tools` by name; they replace a built-in tool with the same name. See [web-tools.md](web-tools.md). |
| `web` | Settings of the built-in `web_search` / `web_fetch` tools: `provider: tavily \| anthropic-native`, `apiKey`, `model`, `maxUses` (`anthropic-native`), `maxResults`, `maxResultsCap`, `maxChars`, `maxFetchChars`, `cacheTtlMs`, `cacheMaxEntries`, `maxTrackedRuns`, `fetchPolicy: search-results \| any \| off`, `maxUrlLength`, `searchDepth`, `topic: general \| news`, `includeDomains`/`excludeDomains`. See [web-tools.md](web-tools.md). |
| `signals` | Settings of the public-signal tools `search_discussions` / `search_projects` / `search_questions` / `search_papers`: `sources` (default all of `hackernews`, `github`, `stackoverflow`, `arxiv`), `maxResults`, `maxResultsCap`, `maxChars`, `cacheTtlMs`, `cacheMaxEntries`, `timeoutMs`, `errorBodyChars`, `rateLimitBodyChars`, `githubToken` (default env `GITHUB_TOKEN`), `githubIssues`, `stackExchangeSite`, `userAgent`. See [signal-tools.md](signal-tools.md). |
| `sinks` | `console`, `jsonl`, `otlp` (`endpoint`, `headers`, `serviceName`, `captureContent`, `metrics`, `intervalMs`, `metricsIntervalMs`), or plugin sinks. |
| `serve` | Limits of `reinloop serve`: `maxBodyBytes`, `requestTimeoutMs`, `headersTimeoutMs`, `errorDescriptionChars`. Options passed to `serve()` win. |
| `limits` | Cross-cutting limits: `maxTurns` (turns of an agent without `budget`), `maxEmptyResponses`, `minSecretChars`. |
| `skillsDir` | Folders with Agent Skills (default `skills/`, `.reinloop/skills/`). |
| `agents`, `teams` | Same fields as agent files ([agent-files.md](agent-files.md), [patterns.md](patterns.md)): `description`, `model`, `instructions`, `tools`, `budget` (`maxTurns`, `maxToolCalls`, `maxInputTokens`, `maxOutputTokens`, `maxTotalTokens`, `maxCostUsd`, `maxDurationMs`), `params` (`temperature`, `maxTokens`, `topP`, `stop`, `thinking` with `type`, `budgetTokens`, `display`, `effort`, `retryMaxTokens`, `extra`), `policy`, `compaction` (`thresholdTokens`, `keepFirst`, `keepLast`, `maxTokens`, `toolResultChars`), `output` (`schema`, `retries`), `asTool` (`name`, `description`, `context`, `forwardEvents`). |
| `$schema` | Optional pointer to `schema/reinloop.schema.json` for editor validation; ignored at runtime. |

## Limits

Every timeout, size, count and cap has a default and a config field, listed below and declared in `LIMITS`
(`src/limits.ts`, exported by the package). Each limit is also a constructor or factory option for code users. The
layout follows [agent-layers limits](https://github.com/aantenore/agent-layers/blob/main/docs/limits.md).

- A limit is an integer, or a `${env:NAME}` placeholder whose value is a number. The value is checked after
  interpolation; the variable itself is only read when its component is built.
- `"unbounded"` turns a limit off, only where the table says so (`Infinity` in code). It never reaches a timer: an
  unbounded timeout means no timer at all.
- Values out of range, non-integers and other strings are rejected when the config is checked.
- At load, unsafe values raise a warning (`process.emitWarning`, type `ReinloopConfigWarning`; `loadConfig` also returns
  them as `warnings` and takes `onWarning`): `"unbounded"` where it removes a protection, and values outside the safe
  range. A warning never changes the value.
- Limits marked with component types apply to those types only; plugin components keep their own options.

```json
{
  "tools": { "shellTimeoutMs": "${env:SHELL_TIMEOUT_MS:-120000}", "maxResultChars": 64000 },
  "mcpServers": { "slow": { "url": "https://mcp.example.com/mcp", "timeoutMs": 300000 } },
  "serve": { "maxBodyBytes": 262144 },
  "limits": { "maxTurns": 80 }
}
```

### Tools

| Setting | Default | Accepted | Safe range | At load | Why |
|---|---|---|---|---|---|
| `tools.concurrency` | 8 | 1–∞ | 1–64 | warn outside safe range | Tool calls of one turn that run in parallel. |
| `tools.timeoutMs` | unbounded | 1–∞ or unbounded | 1000–3600000 | warn outside safe range | Time limit of one tool call (tools may set their own). |
| `tools.maxResultChars` | 32000 | 100–∞ or unbounded | 1000–1000000 | warn if unbounded, warn outside safe range | Tool output kept in the conversation; the rest goes to an artifact or is cut. |
| `tools.shellTimeoutMs` | 120000 | 1–∞ or unbounded | 1000–3600000 | warn if unbounded, warn outside safe range | Time limit of one shell command; the whole process group is killed. |
| `tools.shellMaxOutputChars` | 100000 | 100–∞ or unbounded | 1000–10000000 | warn if unbounded, warn outside safe range | Shell output collected in memory. |
| `tools.shellExitGraceMs` | 200 | 0–∞ | 0–10000 | warn outside safe range | Wait for output after the shell exits while background processes keep the pipes open. |
| `tools.maxWalkFiles` | 20000 | 1–∞ | 1–1000000 | warn outside safe range | Files visited by find_files and search_files. |
| `tools.maxFindResults` | 500 | 1–∞ | 1–100000 | warn outside safe range | Paths returned by find_files. |
| `tools.searchMaxResults` | 200 | 1–∞ | 1–10000 | warn outside safe range | Matches returned by search_files when the model does not ask for a number. |
| `tools.searchMaxFileBytes` | 1000000 | 1–∞ | 1–100000000 | warn outside safe range | Larger files are skipped by search_files. |
| `tools.searchLineChars` | 300 | 20–∞ | — | — | Characters kept of each matching line. |
| `tools.artifactReadChars` | 8000 | 100–∞ | — | — | Characters read_artifact returns when the model gives no limit. |
| `tools.skillMaxFileBytes` | 1000000 | 1–∞ | 1–100000000 | warn outside safe range | Largest skill resource file the skill tool loads. |
| `tools.skillDescriptionChars` | 300 | 20–∞ | — | — | Characters of each skill description listed in the tool description. |

### Memory

| Setting | Default | Accepted | Safe range | At load | Why |
|---|---|---|---|---|---|
| `memory.recallLimit` | 8 | 1–∞ | 1–100 | warn outside safe range | Notes recall returns when the model gives no limit. |

### Web

| Setting | Default | Accepted | Safe range | At load | Why |
|---|---|---|---|---|---|
| `web.maxResults` | 5 | 1–∞ | — | — | Results per search when the model does not ask (capped by maxResultsCap). |
| `web.maxResultsCap` | 10 | 1–∞ | 1–50 | warn outside safe range | Most results the model may ask for. |
| `web.maxChars` | 1000 | 50–∞ | — | — | Characters kept per search snippet. |
| `web.maxFetchChars` | 8000 | 100–∞ | 100–200000 | warn outside safe range | Characters kept of a fetched page. |
| `web.cacheTtlMs` | 0 | 0–∞ | 0–86400000 | warn outside safe range | In-memory result cache lifetime (0: off). |
| `web.cacheMaxEntries` | 200 | 1–∞ | 1–100000 | warn outside safe range | Results kept in the cache. |
| `web.maxUrlLength` | 512 | 16–∞ | 16–2048 | warn outside safe range | Longest URL web_fetch accepts; long URLs can carry exfiltrated data. |
| `web.maxUses` | 1 | 1–∞ | 1–10 | warn outside safe range | Hosted searches per query (anthropic-native). |
| `web.maxTrackedRuns` | 200 | 1–∞ | 1–100000 | warn outside safe range | Runs whose search results web_fetch remembers (oldest are forgotten). |

### Signals

| Setting | Default | Accepted | Safe range | At load | Why |
|---|---|---|---|---|---|
| `signals.maxResults` | 5 | 1–∞ | — | — | Results per search when the model does not ask (capped by maxResultsCap). |
| `signals.maxResultsCap` | 10 | 1–∞ | 1–100 | warn outside safe range | Most results the model may ask for. |
| `signals.maxChars` | 300 | 20–∞ | — | — | Characters kept per title or description. |
| `signals.cacheTtlMs` | 0 | 0–∞ | 0–86400000 | warn outside safe range | In-memory result cache lifetime (0: off). |
| `signals.cacheMaxEntries` | 200 | 1–∞ | 1–100000 | warn outside safe range | Results kept in the cache. |
| `signals.timeoutMs` | 10000 | 100–∞ | 1000–60000 | warn outside safe range | Time limit of one request to a public API. |
| `signals.errorBodyChars` | 300 | 0–∞ | — | — | Response text kept in an HTTP error. |
| `signals.rateLimitBodyChars` | 200 | 0–∞ | — | — | Response text kept in a throttling error. |

### Knowledge

| Setting | Default | Accepted | Safe range | At load | Why |
|---|---|---|---|---|---|
| `knowledge.k` | 4 | 1–∞ | 1–50 | warn outside safe range | Passages per retrieval. |
| `knowledge.maxK` | 10 | 1–∞ | 1–100 | warn outside safe range | Most passages search_knowledge may ask for. |
| `knowledge.maxChars` | 6000 | 100–∞ | 100–100000 | warn outside safe range | Passage text appended to the user message by the middleware (search_knowledge too, unless toolMaxChars is set). |
| `knowledge.toolMaxChars` | 8000 | 100–∞ | 100–100000 | warn outside safe range | Passage text of one search_knowledge result (default: maxChars when set). |
| `knowledge.timeoutMs` | 10000 | 100–∞ | 100–60000 | warn outside safe range | Per-source time limit; a slow source is skipped, the run goes on. |
| `knowledge.maxQueryChars` | 1000 | 10–∞ | — | — | Characters of the user text sent as the query. |
| `knowledge.maxTrackedRuns` | 64 | 1–∞ | 1–100000 | warn outside safe range | Runs whose retrieved blocks are kept in memory (a forgotten run costs one re-query). |
| `knowledge.sources.<name>.timeoutMs` | 10000 | 1–∞ | 100–60000 | warn outside safe range | Time limit of one request to an http source (`http` only). |
| `knowledge.sources.<name>.timeoutMs` | 60000 | 1–∞ | 1000–600000 | warn outside safe range | MCP request time limit of an inline mcp source (a named server uses its own) (`mcp` only). |
| `knowledge.sources.<name>.maxPassageChars` | 1500 | 100–∞ | — | — | Size of the passages a wiki page is split into (`wiki` only). |
| `knowledge.sources.<name>.errorBodyChars` | 300 | 0–∞ | — | — | Response text kept in a source error (secrets are masked first) (`http`, `mcp` only). |

### MCP servers

| Setting | Default | Accepted | Safe range | At load | Why |
|---|---|---|---|---|---|
| `mcpServers.<name>.timeoutMs` | 60000 | 1–∞ or unbounded | 1000–600000 | warn if unbounded, warn outside safe range | Time limit of one MCP request (connect, list, call). |
| `mcpServers.<name>.errorBodyChars` | 300 | 0–∞ | — | — | Response text kept in an HTTP error (secrets are masked first). |
| `mcpServers.<name>.stderrChars` | 2000 | 0–∞ | — | — | Tail of a stdio server stderr kept for error messages. |

### HTTP and OpenAPI tools

| Setting | Default | Accepted | Safe range | At load | Why |
|---|---|---|---|---|---|
| `httpTools.<name>.timeoutMs` | unbounded | 1–∞ or unbounded | 1000–600000 | warn if unbounded, warn outside safe range | Time limit of one call; without it tools.timeoutMs applies, "unbounded" overrides that. |
| `httpTools.<name>.maxResultChars` | 16000 | 100–∞ or unbounded | 1000–1000000 | warn if unbounded, warn outside safe range | Response text returned to the model. |
| `httpTools.<name>.errorBodyChars` | 500 | 0–∞ | — | — | Response text kept in an error result (secrets are masked first). |
| `openapi.<name>.timeoutMs` | unbounded | 1–∞ or unbounded | 1000–600000 | warn if unbounded, warn outside safe range | Time limit of one call; without it tools.timeoutMs applies, "unbounded" overrides that. |
| `openapi.<name>.maxResultChars` | 16000 | 100–∞ or unbounded | 1000–1000000 | warn if unbounded, warn outside safe range | Response text returned to the model. |
| `openapi.<name>.errorBodyChars` | 500 | 0–∞ | — | — | Response text kept in an error result (secrets are masked first). |
| `openapi.<name>.specTimeoutMs` | 30000 | 1–∞ | 1000–120000 | warn outside safe range | Time limit for downloading a spec given as a URL. |
| `openapi.<name>.maxRefDepth` | 24 | 1–∞ | 1–64 | warn outside safe range | Nested $ref levels inlined; deeper ones become an open schema. |
| `openapi.<name>.descriptionChars` | 1000 | 50–∞ | — | — | Characters of an operation summary used as the tool description. |

### Providers

| Setting | Default | Accepted | Safe range | At load | Why |
|---|---|---|---|---|---|
| `providers.<name>.retry.maxAttempts` | 3 | 1–∞ | 1–10 | warn outside safe range | Tries of one model request, the first included (`openai-compatible`, `anthropic` only). |
| `providers.<name>.retry.baseDelayMs` | 500 | 0–∞ | 100–10000 | warn outside safe range | First backoff delay, doubled on each retry (with jitter) (`openai-compatible`, `anthropic` only). |
| `providers.<name>.retry.maxDelayMs` | 30000 | 0–∞ | 1000–300000 | warn outside safe range | Longest wait between tries, Retry-After included (`openai-compatible`, `anthropic` only). |
| `providers.<name>.errorBodyChars` | 500 | 0–∞ | — | — | Response text kept in an HTTP error (`openai-compatible`, `anthropic` only). |
| `providers.<name>.responseExcerptChars` | 300 | 0–∞ | — | — | Response JSON kept when a response has an unexpected shape (`openai-compatible`, `anthropic` only). |
| `providers.<name>.cacheMinTokens` | 1024 | 0–∞ | — | — | Shorter prompt prefixes get no cache breakpoint (`anthropic` only). |
| `providers.<name>.defaultMaxTokens` | 4096 | 1–∞ | — | — | Output tokens per request when the agent sets no params.maxTokens (`anthropic` only). |

### Response cache

| Setting | Default | Accepted | Safe range | At load | Why |
|---|---|---|---|---|---|
| `responseCache.ttlMs` | unbounded | 1–∞ or unbounded | — | — | How long a cached response is replayed. |
| `responseCache.maxEntries` | 1000 | 1–∞ | 1–1000000 | warn outside safe range | Responses kept by the memory cache (oldest are dropped) (`memory` only). |

### Agents

| Setting | Default | Accepted | Safe range | At load | Why |
|---|---|---|---|---|---|
| `agents.<name>.output.retries` | 1 | 0–∞ | 0–5 | warn outside safe range | Extra model calls when the final answer does not match output.schema. |
| `agents.<name>.compaction.keepFirst` | 1 | 0–∞ | — | — | Leading messages (the task) kept by window compaction (`window` only). |
| `agents.<name>.compaction.keepLast` | 20 | 1–∞ | — | — | Recent messages kept by window compaction (`window` only). |
| `agents.<name>.compaction.keepLast` | 10 | 1–∞ | — | — | Recent messages kept verbatim by summarize compaction (`summarize` only). |
| `agents.<name>.compaction.maxTokens` | 2048 | 1–∞ | — | — | Output tokens of the summary request (`summarize` only). |
| `agents.<name>.compaction.toolResultChars` | 2000 | 0–∞ | — | — | Characters of each tool result in the transcript sent for summary (`summarize` only). |
| `teams.<name>.options.maxRounds` | 3 | 1–∞ | 1–10 | warn outside safe range | Generate-and-judge rounds of an evaluator team. |
| `teams.<name>.options.judgeRetries` | 1 | 0–∞ | 0–5 | warn outside safe range | Extra judge calls when the verdict is not valid { pass, feedback } JSON. |

### Identity

| Setting | Default | Accepted | Safe range | At load | Why |
|---|---|---|---|---|---|
| `identity.verifier.timeoutMs` | 5000 | 1–∞ | 500–30000 | warn outside safe range | Time limit of one discovery or JWKS request (`oidc` only). |
| `identity.verifier.clockSkewSec` | 60 | 0–∞ | 0–300 | warn outside safe range | Clock drift tolerated when checking exp, nbf and iat (`oidc` only). |
| `identity.verifier.jwksMinRefreshMs` | 30000 | 0–∞ | 1000–3600000 | warn outside safe range | Shortest gap between JWKS fetches, so unknown key ids cannot flood the IdP (`oidc` only). |
| `identity.verifier.jwksMaxAgeMs` | 600000 | 1–∞ | 60000–86400000 | warn outside safe range | How long fetched keys are used before a refresh (`oidc` only). |
| `identity.verifier.maxTokenAgeSec` | unbounded | 1–∞ or unbounded | — | — | Oldest token accepted, by iat (off by default) (`oidc` only). |
| `identity.verifier.maxTokenChars` | 16384 | 256–∞ | 1024–65536 | warn outside safe range | Longest bearer token parsed; longer input is rejected before any work (`oidc` only). |
| `identity.verifier.maxKeyCandidates` | 5 | 1–∞ | 1–20 | warn outside safe range | Keys tried for a token without kid; bounds signature checks per request (`oidc` only). |
| `identity.verifier.maxResponseBytes` | 1000000 | 1024–∞ | 16384–10000000 | warn outside safe range | Largest JSON document read from the server (`oidc` only). |
| `identity.verifier.errorBodyChars` | 200 | 0–∞ | — | — | Server error text kept in error messages (`oidc` only). |
| `identity.credentials.timeoutMs` | 10000 | 1–∞ | 500–60000 | warn outside safe range | Time limit of one discovery or token request (`oidc` only). |
| `identity.credentials.refreshSkewSec` | 30 | 0–∞ | 0–300 | warn outside safe range | Cached tokens are renewed this long before they expire (`oidc` only). |
| `identity.credentials.defaultTtlSec` | 60 | 1–∞ | 1–3600 | warn outside safe range | Lifetime assumed for an opaque token sent without expires_in (`oidc` only). |
| `identity.credentials.maxCacheEntries` | 1000 | 1–∞ | 1–100000 | warn outside safe range | Tokens cached at once (`oidc` only). |
| `identity.credentials.maxResponseBytes` | 1000000 | 1024–∞ | 16384–10000000 | warn outside safe range | Largest JSON document read from the server (`oidc` only). |
| `identity.credentials.errorBodyChars` | 200 | 0–∞ | — | — | Server error text kept in error messages (`oidc` only). |
| `policy.pdp.timeoutMs` | 5000 | 1–∞ | 100–30000 | warn outside safe range | Time limit of one PDP decision; a timeout is handled by onError (`opa`, `authzen` only). Also `agents.<name>.policy.pdp.timeoutMs`. |
| `policy.pdp.maxResponseBytes` | 1000000 | 1024–∞ | 16384–10000000 | warn outside safe range | Largest JSON document read from the server (`opa`, `authzen` only). Also `agents.<name>.policy.pdp.maxResponseBytes`. |
| `policy.pdp.errorBodyChars` | 200 | 0–∞ | — | — | Server error text kept in error messages (`opa`, `authzen` only). Also `agents.<name>.policy.pdp.errorBodyChars`. |
| `policy.pdp.maxReasonChars` | 200 | 20–∞ | — | — | Characters of a PDP reason or error kept in the decision. Also `agents.<name>.policy.pdp.maxReasonChars`. |

### Guardrails

| Setting | Default | Accepted | Safe range | At load | Why |
|---|---|---|---|---|---|
| `guardrails.guards[].timeoutMs` | 10000 | 1–∞ | 100–60000 | warn outside safe range | Time limit of one guard call; a timeout is handled by onError (`http`, `presidio`, `llm-guard` only). |
| `guardrails.maxReasonChars` | 200 | 20–∞ | — | — | Characters of a guard reason kept in events and run results. |

### Telemetry

| Setting | Default | Accepted | Safe range | At load | Why |
|---|---|---|---|---|---|
| `sinks[].intervalMs` | 2000 | 100–∞ | 500–60000 | warn outside safe range | How often buffered spans are exported (metrics too, unless metricsIntervalMs is set) (`otlp` only). |
| `sinks[].metricsIntervalMs` | 10000 | 100–∞ | 1000–300000 | warn outside safe range | How often metrics are exported (`otlp` only). |

### Serve

| Setting | Default | Accepted | Safe range | At load | Why |
|---|---|---|---|---|---|
| `serve.maxBodyBytes` | 1000000 | 1–∞ or unbounded | 1024–10485760 | warn if unbounded, warn outside safe range | Largest request body; bigger ones get 413 and the connection is closed. |
| `serve.requestTimeoutMs` | 300000 | 1–∞ or unbounded | 1000–3600000 | warn if unbounded, warn outside safe range | Time to receive a whole request (Node default); slow clients cannot hold sockets. |
| `serve.headersTimeoutMs` | 60000 | 1–∞ or unbounded | 1000–300000 | warn if unbounded, warn outside safe range | Time to receive the request headers (Node default; never above requestTimeoutMs). |
| `serve.errorDescriptionChars` | 120 | 0–∞ | — | — | Verifier reason kept in the WWW-Authenticate error_description. |

### Run loop and redaction

| Setting | Default | Accepted | Safe range | At load | Why |
|---|---|---|---|---|---|
| `limits.maxTurns` | 50 | 1–∞ or unbounded | 1–1000 | warn if unbounded, warn outside safe range | Turns of an agent that sets no budget; with "unbounded" a looping agent never stops. |
| `limits.maxEmptyResponses` | 2 | 0–∞ | 0–10 | warn outside safe range | Empty model responses in a row before the run fails. |
| `limits.minSecretChars` | 4 | 1–∞ | 1–8 | warn outside safe range | Shorter secrets are not masked in echoed error text (they would mangle ordinary text). |

### Not configurable

These numbers are fixed on purpose: protocol constants (HTTP and JSON-RPC status codes, MCP protocol version, the
W3C trace and span id lengths), crypto floors fixed by standards (RSA keys of at least 2048 bits), the built-in price
table, format checks (card number lengths, IBAN lengths, Luhn and mod-97 arithmetic, IPv4 ranges), id and hash lengths
(run, call and artifact ids, passage hashes), unit conversions (ms, s, ns, tokens per million), the token estimate of 4
characters per token, OTLP histogram bucket bounds, preview text in console and OTLP sinks, the web console, the CLI
approval prompt and eval reports (display only), sample sizes inside conformance checks, and starter values written
into generated agent files.

## Plugins

A plugin is an ES module whose default export (or `register`) receives the registry:

```js
export default (registry) => {
  registry.providers.set('my-gateway', (options, ctx) => myProvider(options));
  registry.tools.set('jira_search', (options, ctx) => jiraSearchTool(ctx.env.JIRA_TOKEN));
  registry.middleware.set('pii-guard', () => ({ afterTool: (r) => ({ ...r, content: redact(r.content) }) }));
  registry.patterns.set('debate', debatePattern);
  registry.sinks.set('otel', () => otelSink({ tracer }));
  registry.caches.set('redis', (o) => redisCache(o.url));
  registry.compaction.set('keep-decisions', (o) => myCompaction(o));
  registry.stores.set('postgres', (o) => pgStore(o.url));
};
```

Factories receive `(options, ctx)`, where `ctx` has `baseDir`, `env`, `workspace`, `config` and
`once(key, create)` for per-runtime singletons.
