# Layer hooks

reinloop is the runtime of a larger agent platform. It keeps the generic hooks of each layer: the interfaces in
`src/types.ts` (the `Layer` union names the layers) and the places in the loop and the config where an implementation
plugs in. Implementations (OIDC, OPA, Presidio, knowledge sources, HTTP/OpenAPI tools, rule router, evaluators, ...) live
in [agent-layers](https://github.com/aantenore/agent-layers) and ship as subpaths of one package,
`@agent-layers/adapters` (0.4.0 or later; the older per-adapter packages are deprecated). Layers are referred to by id.

```bash
npm i @agent-layers/adapters      # then import '@agent-layers/adapters/<name>', e.g. '@agent-layers/adapters/reinloop'
```

| Layer id | Page | reinloop hook | Config | Implementations in agent-layers |
|---|---|---|---|---|
| `llm` | [llm.md](llm.md) | `Provider`, `withRetry`, `withFallback`, `checkProvider`, `checkOpenAIEndpoint` | `providers`, `models` | built in: OpenAI-compatible, Anthropic, mock |
| `cache` | [cache.md](cache.md) | `CacheStore`, `withResponseCache`, `ModelRouter`, `routedModel`, `withRouter` | `responseCache`, `routers`, agent `router` | `@agent-layers/adapters/rule-router` |
| `knowledge` | [knowledge.md](knowledge.md) | `KnowledgeSource`, `knowledgeMiddleware` | `middleware` (registered by a plugin) | `@agent-layers/adapters/mcp`, `@agent-layers/adapters/http-knowledge`, `@agent-layers/adapters/markdown-knowledge` |
| `tool` | [tool.md](tool.md) | `Tool`, `defineTool`, `mcpTools`, `registry.tools` | `mcpServers`, `tools` | `@agent-layers/adapters/http-tools`, `@agent-layers/adapters/openapi` |
| `identity` | [identity.md](identity.md) | `IdentityVerifier`, `CredentialProvider`, `CredentialFactory`, `Authorizer`, `authorizeCall` | `identity`, `policy.pdp` | `@agent-layers/adapters/oidc`, `@agent-layers/adapters/opa`, `@agent-layers/adapters/authzen` |
| `guardrail` | [guardrail.md](guardrail.md) | `Guard`, `guardMiddleware` | `middleware` (registered by a plugin) | `@agent-layers/adapters/presidio`, `@agent-layers/adapters/llm-guard`, `@agent-layers/adapters/http-guard`, `@agent-layers/adapters/regex-guard` |
| `telemetry` | [telemetry.md](telemetry.md) | `Sink`, `otlpSink`, `EVENT_LAYERS` | `sinks` | built in: console, jsonl, OTLP |
| `eval` | [eval.md](eval.md) | `Evaluator`, `EvalCase`, `EvalScore`, `RunStore` | none | `@agent-layers/adapters/expected-eval`, `@agent-layers/adapters/judge-eval`, `@agent-layers/adapters/layer-signals` |

`harness`, `infra` and `interface` have no adapter contract; they appear as `Layer` values on spans and tools.

## Getting implementations

1. Run reinloop as the runtime under agent-layers with `@agent-layers/adapters/reinloop`; the SDK governs model and tool access.
2. Implement the reinloop interface (or wrap an agent-layers adapter) in a reinloop plugin that registers it in the
   registry (`registry.middleware`, `registry.routers`, `registry.verifiers`, `registry.credentials`,
   `registry.authorizers`, `registry.tools`). Plugins are listed in the config under `plugins`.

Config files that still use the removed sections `knowledge`, `guardrails`, `httpTools` or `openapi` fail with an error
that points to agent-layers. Conformance kits for the contracts are in `@agent-layers/conformance`; reinloop keeps
`checkProvider` and `checkOpenAIEndpoint`.
