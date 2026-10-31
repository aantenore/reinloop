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
needs it is built, so an unused provider never blocks a run.

## Sections

| Section | Notes |
|---|---|
| `providers.<name>` | `type`: `openai-compatible` (`baseUrl`, `apiKey`, `headers`, `stream`, `maxTokensParam`, `structuredOutput: true \| false \| "without-tools"`), `anthropic` (`baseUrl`, `apiKey`, `version`, `headers`, `stream`, `cache` (default on: breakpoints on tools, system prompt and the latest message; agents override with `params.cache` / `params.cacheTtl: "5m" \| "1h"`), `cacheTtl`, `cacheMinTokens` (default 1024: shorter prefixes get no breakpoint), `defaultMaxTokens`, `structuredOutput`), `mock` (`responses`, `loop`), or a plugin type. `retry: false \| { maxAttempts, baseDelayMs, maxDelayMs, retryOn }` (retries are on by default). A provider named `x` makes `x/<model>` strings work. |
| `presets.<name>` | Settings for a built-in preset used as `"<name>/<model>"`: `headers` (extra request headers, `${env:...}` allowed). Ignored when `providers.<name>` defines a provider with the same name. Presets also read headers from env vars: `ANTHROPIC_WORKSPACE_ID` becomes `anthropic-workspace-id` for `anthropic/...`; config headers win over env ones. |
| `models.<alias>` | `provider`, `model`, `params`, `pricing` (USD per million tokens, used for cost budgets), `fallback` (aliases tried in order). |
| `pricing.<model id>` | Price overrides (`inputPerMTok`, `outputPerMTok`, `cacheReadPerMTok`, USD per million tokens; `cacheWriteMultiplier` / `cacheWrite1hMultiplier`, cache writes as a multiple of the input price, built in for Claude as 1.25 / 2; `serverToolUsd`, USD per hosted-tool request such as `{ "webSearchRequests": 0.01 }`) keyed by the model id without the provider prefix, merged field by field over the built-in table (`PRICING`: `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`). `models.<alias>.pricing` takes precedence. Models without a price cost 0, so `maxCostUsd` does not limit them. |
| `mcpServers.<name>` | stdio (`command`, `args`, `env`, `cwd`) or HTTP (`url`, `headers`); `prefix`, `include`/`exclude` globs, `risk` (otherwise derived from tool annotations), `readOnly` (globs of tool names treated as `read`), `timeoutMs`, `auth: { audience, scopes? }` (streamable HTTP only: every call carries a token for that audience from the run's credentials, see [layers/identity.md](layers/identity.md#mcp-streamable-http)). Tools appear as `<prefix>__<tool>` (prefix defaults to the server name); `prefix: false` (or `""`) keeps the server's own names, and agents then select them with `mcp:<name>` (narrow with `include`). |
| `httpTools.<name>` | Declarative HTTP tool: `description`, `method`, `url` (with `{param}`), `schema` (`properties`, `required`), `query`, `headerArgs`, `headers`, `body: json \| none`, `bodyArg`, `risk`, `timeoutMs`, `maxResultChars`, `auth: { audience, scopes? }`. See [layers/tool.md](layers/tool.md). |
| `openapi.<name>` | Tools generated from an OpenAPI 3 JSON document, one per operation: `spec` (path or URL), `baseUrl`, `include` (globs over `operationId`), `headers`, `timeoutMs`, `maxResultChars`, `auth: { audience, scopes? }`. Tool names are prefixed with `<name>__`. See [layers/tool.md](layers/tool.md). |
| `tools` | Workspace root and execution limits; `artifacts: none \| memory \| file` enables offloading when an agent lists `read_artifact`. |
| `policy` | Global rules, evaluated after each agent's own rules. `default`, `risk.<read\|write\|exec>` and `rules[]` (`match` glob, `risk`, `action: allow \| ask \| deny`, `reason`, `when: { roles, scopes, kind }`; `roles` and `scopes` match any-of, `kind` is `user` or `agent`, and a rule with `when` never matches a run without identity). Unlabelled tools (your functions) are allowed by default; `read` is allowed, while `write` and `exec` ask. With no approver, "ask" means deny. |
| `policy.pdp` | External policy decision point asked after the local rules (a local `deny` is final): `type` (`opa`, `authzen`, or a plugin), `url`, `path` (OPA), `headers`, `includeArgs` (send tool arguments; off by default), `onError: allow \| ask \| deny` (default `deny`). See [layers/identity.md](layers/identity.md#external-pdp). |
| `identity` | `verifier` (turns a bearer token into the run identity) and `credentials` (outbound tokens: `mode: on-behalf-of \| self`), each with `type` (default `oidc`) plus the factory's own fields (`issuer`, `audience`, `clientId`, `clientSecret`); `required` (default true): `reinloop serve` rejects `/v1/*` calls without a valid token. See [layers/identity.md](layers/identity.md). |
| `knowledge` | Retrieval sources and auto-retrieval settings: `sources.<name>` with `type: mcp \| http \| wiki` (`mcp`: `server` or `command`/`args`/`env`/`cwd` or `url`/`headers`, `tool`, `queryArg`, `toolArgs`; `http`: `url`, `headers`; `wiki`: `dir`, `maxPassageChars`; all: `timeoutMs`), `k`, `maxChars`, `mode: first-turn \| every-turn` (default `first-turn`), `timeoutMs`. Agents enable it with `tools: [search_knowledge]` and/or `middleware: [knowledge]`. See [layers/knowledge.md](layers/knowledge.md). |
| `guardrails` | `guards[]` (each with `type`: `regex`, `presidio`, `llm-guard`, `http`, or a plugin, plus its options), `onError: block \| allow` (default `block`, fail closed), `name`. Agents opt in with `middleware: [guard]`. See [layers/guardrail.md](layers/guardrail.md). |
| `routers.<name>` | Model routers (`type: rule` with `rules[]` of `when: { minEstTokens, maxEstTokens, hasTools, turnAtLeast }` and `model`, plus `default`; or a plugin type). Agents attach one with `router: <name>`. See [layers/cache.md](layers/cache.md). |
| `store` | `memory` or `file`: the event log used for sessions and resume. |
| `responseCache` | `memory` or `file` (+ `ttlMs`, `namespace`): identical requests replay at zero cost. Agents opt out with `responseCache: false`. |
| `memory` | Backing store for `remember` / `recall`; `scope: shared \| agent`. |
| `hostedTools.<name>` | Provider-hosted tools (`provider`, `type`, `params`, `risk`, `description`, `limitParam` (name of the `params` field that receives the remaining tool-call budget, e.g. `max_uses`), `beta`) that agents list in `tools` by name; they replace a built-in tool with the same name. See [web-tools.md](web-tools.md). |
| `web` | Settings of the built-in `web_search` / `web_fetch` tools: `provider: tavily \| anthropic-native`, `apiKey`, `model`, `maxUses` (`anthropic-native`), `maxResults`, `maxChars`, `maxFetchChars`, `cacheTtlMs`, `fetchPolicy: search-results \| any \| off`, `maxUrlLength`, `searchDepth`, `topic: general \| news`, `includeDomains`/`excludeDomains`. See [web-tools.md](web-tools.md). |
| `signals` | Settings of the public-signal tools `search_discussions` / `search_projects` / `search_questions` / `search_papers`: `sources` (default all of `hackernews`, `github`, `stackoverflow`, `arxiv`), `maxResults`, `maxResultsCap`, `maxChars`, `cacheTtlMs`, `timeoutMs`, `githubToken` (default env `GITHUB_TOKEN`), `githubIssues`, `stackExchangeSite`, `userAgent`. See [signal-tools.md](signal-tools.md). |
| `sinks` | `console`, `jsonl`, `otlp` (`endpoint`, `headers`, `serviceName`, `captureContent`), or plugin sinks. |
| `skillsDir` | Folders with Agent Skills (default `skills/`, `.reinloop/skills/`). |
| `agents`, `teams` | Same fields as agent files ([agent-files.md](agent-files.md), [patterns.md](patterns.md)): `description`, `model`, `instructions`, `tools`, `budget` (`maxTurns`, `maxToolCalls`, `maxInputTokens`, `maxOutputTokens`, `maxTotalTokens`, `maxCostUsd`, `maxDurationMs`), `params` (`temperature`, `maxTokens`, `topP`, `stop`, `thinking` with `type`, `budgetTokens`, `display`, `effort`, `retryMaxTokens`, `extra`), `policy`, `compaction` (`thresholdTokens`, ...), `output` (`schema`), `asTool` (`name`, `description`, `context`, `forwardEvents`). |
| `$schema` | Optional pointer to `schema/reinloop.schema.json` for editor validation; ignored at runtime. |

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
