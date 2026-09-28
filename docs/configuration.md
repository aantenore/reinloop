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
  "defaultModel": "${env:REINLOOP_MODEL:-anthropic/claude-sonnet-5}",
  "agentsDir": ["agents", "shared/agents"],
  "skillsDir": ["skills", "~/team-skills"],

  "providers": {
    "corp": { "type": "openai-compatible", "baseUrl": "https://llm.internal/v1", "apiKey": "${env:CORP_KEY}", "stream": true, "retry": { "maxAttempts": 4 } }
  },
  "models": {
    "fast": { "provider": "corp", "model": "llama-4-70b", "fallback": ["smart"] },
    "smart": { "provider": "corp", "model": "big-model", "pricing": { "inputPerMTok": 3, "outputPerMTok": 15, "cacheReadPerMTok": 0.3 } }
  },

  "mcpServers": {
    "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."], "exclude": ["write_*"] },
    "docs": { "url": "https://mcp.example.com/mcp", "headers": { "authorization": "Bearer ${env:DOCS_TOKEN}" }, "risk": "read" }
  },

  "tools": { "workspace": ".", "concurrency": 8, "timeoutMs": 120000, "maxResultChars": 32000, "artifacts": "file", "shellTimeoutMs": 120000 },
  "policy": { "risk": { "write": "allow" }, "rules": [{ "match": "shell", "action": "ask" }, { "match": "fs__*", "risk": "exec", "action": "deny" }] },

  "store": { "type": "file", "dir": ".reinloop/runs" },
  "responseCache": { "type": "file", "dir": ".reinloop/cache", "ttlMs": 86400000, "namespace": "v1" },
  "memory": { "type": "file", "dir": ".reinloop/memory", "scope": "shared" },
  "sinks": [{ "type": "console", "level": "info" }, { "type": "jsonl", "dir": ".reinloop/traces" }],

  "agents": { "coder": { "model": "fast", "instructions": "file:./prompts/coder.md", "tools": ["read_file", "edit_file", "shell", "fs__*"] } },
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
| `providers.<name>` | `type`: `openai-compatible` (`baseUrl`, `apiKey`, `headers`, `stream`, `maxTokensParam`, `structuredOutput`), `anthropic` (`baseUrl`, `apiKey`, `version`, `stream`, `cache`, `defaultMaxTokens`), `mock` (`responses`, `loop`), or a plugin type. `retry: false \| { maxAttempts, baseDelayMs, maxDelayMs, retryOn }` (retries are on by default). A provider named `x` makes `x/<model>` strings work. |
| `models.<alias>` | `provider`, `model`, `params`, `pricing` (USD per million tokens, used for cost budgets), `fallback` (aliases tried in order). |
| `mcpServers.<name>` | stdio (`command`, `args`, `env`, `cwd`) or HTTP (`url`, `headers`); `prefix`, `include`/`exclude` globs, `risk` (otherwise derived from tool annotations), `timeoutMs`. Tools appear as `<prefix>__<tool>`. |
| `tools` | Workspace root and execution limits; `artifacts: none \| memory \| file` enables offloading when an agent lists `read_artifact`. |
| `policy` | Global rules, evaluated after each agent's own rules. Unlabelled tools (your functions) are allowed by default; `read` is allowed, while `write` and `exec` ask. With no approver, "ask" means deny. |
| `store` | `memory` or `file`: the event log used for sessions and resume. |
| `responseCache` | `memory` or `file` (+ `ttlMs`, `namespace`): identical requests replay at zero cost. Agents opt out with `responseCache: false`. |
| `memory` | Backing store for `remember` / `recall`; `scope: shared \| agent`. |
| `sinks` | `console`, `jsonl`, `otlp` (`endpoint`, `headers`, `serviceName`, `captureContent`), or plugin sinks. |
| `skillsDir` | Folders with Agent Skills (default `skills/`, `.reinloop/skills/`). |
| `agents`, `teams` | Same fields as agent files ([agent-files.md](agent-files.md), [patterns.md](patterns.md)). |

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
