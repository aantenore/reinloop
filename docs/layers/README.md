# Layer hooks

reinloop is the runtime of a larger agent platform. It keeps the generic hooks of each layer: the interfaces in
`src/types.ts` (the `Layer` union names the layers) and the places in the loop and the config where an implementation
plugs in. Implementations (OIDC, OPA, Presidio, knowledge sources, HTTP/OpenAPI tools, rule router, evaluators, ...) live
in [agent-layers](https://github.com/aantenore/agent-layers), under `adapters/`. Layers are referred to by id.

| Layer id | Page | reinloop hook | Config | Implementations in agent-layers |
|---|---|---|---|---|
| `llm` | [llm.md](llm.md) | `Provider`, `withRetry`, `withFallback`, `checkProvider`, `checkOpenAIEndpoint` | `providers`, `models` | built in: OpenAI-compatible, Anthropic, mock |
| `cache` | [cache.md](cache.md) | `CacheStore`, `withResponseCache`, `ModelRouter`, `routedModel`, `withRouter` | `responseCache`, `routers`, agent `router` | `adapter-rule-router` |
| `knowledge` | [knowledge.md](knowledge.md) | `KnowledgeSource`, `knowledgeMiddleware` | `middleware` (registered by a plugin) | `adapter-mcp`, `adapter-http-knowledge`, `adapter-markdown-knowledge` |
| `tool` | [tool.md](tool.md) | `Tool`, `defineTool`, `mcpTools`, `registry.tools` | `mcpServers`, `tools` | `adapter-http-tools`, `adapter-openapi` |
| `identity` | [identity.md](identity.md) | `IdentityVerifier`, `CredentialProvider`, `CredentialFactory`, `Authorizer`, `authorizeCall` | `identity`, `policy.pdp` | `adapter-oidc`, `adapter-opa`, `adapter-authzen` |
| `guardrail` | [guardrail.md](guardrail.md) | `Guard`, `guardMiddleware` | `middleware` (registered by a plugin) | `adapter-presidio`, `adapter-llm-guard`, `adapter-http-guard`, `adapter-regex-guard` |
| `telemetry` | [telemetry.md](telemetry.md) | `Sink`, `otlpSink`, `EVENT_LAYERS` | `sinks` | built in: console, jsonl, OTLP |
| `eval` | [eval.md](eval.md) | `Evaluator`, `EvalCase`, `EvalScore`, `RunStore` | none | `adapter-expected-eval`, `adapter-judge-eval`, `adapter-layer-signals` |

`harness`, `infra` and `interface` have no adapter contract; they appear as `Layer` values on spans and tools.

## Getting implementations

1. Run reinloop as the runtime under agent-layers with `@agent-layers/adapter-reinloop`; the SDK governs model and tool access.
2. Implement the reinloop interface (or wrap an agent-layers adapter) in a reinloop plugin that registers it in the
   registry (`registry.middleware`, `registry.routers`, `registry.verifiers`, `registry.credentials`,
   `registry.authorizers`, `registry.tools`). Plugins are listed in the config under `plugins`.

Config files that still use the removed sections `knowledge`, `guardrails`, `httpTools` or `openapi` fail with an error
that points to agent-layers. Conformance kits for the contracts are in `@agent-layers/conformance`; reinloop keeps
`checkProvider` and `checkOpenAIEndpoint`.
