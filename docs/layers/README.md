# Layer integrations

reinloop is the harness of a larger agent platform. Each platform layer has a contract in `src/types.ts` (the `Layer`
union names them), reference adapters, a conformance check and one page here. Layers are referred to by id, never by
number.

| Layer id | Page | Contract | Standard / reference | Conformance |
|---|---|---|---|---|
| `llm` | [llm.md](llm.md) | `Provider` | OpenAI-compatible Chat Completions, Anthropic Messages | `checkProvider`, `checkOpenAIEndpoint` |
| `cache` | [cache.md](cache.md) | `CacheStore`, `ModelRouter` | response cache, `ruleRouter`, gateways (LiteLLM) | none |
| `knowledge` | [knowledge.md](knowledge.md) | `KnowledgeSource` | MCP (`mcpKnowledge`), HTTP, local wiki | `checkKnowledgeSource` |
| `tool` | [tool.md](tool.md) | `Tool` | MCP, HTTP tools, OpenAPI 3 | none |
| `identity` | [identity.md](identity.md) | `IdentityVerifier`, `CredentialProvider`, `Authorizer` | OIDC/JWT, RFC 8693 token exchange, AuthZEN, OPA | `checkIdentityVerifier`, `checkCredentialProvider`, `checkAuthorizer` |
| `guardrail` | [guardrail.md](guardrail.md) | `Guard` | Presidio, LLM Guard, HTTP, regex | `checkGuard` |
| `telemetry` | [telemetry.md](telemetry.md) | `Sink` | OpenTelemetry (OTLP/HTTP traces and metrics, GenAI conventions) | none |
| `eval` | [eval.md](eval.md) | `Evaluator` | JSONL datasets, replay, LLM as judge | `checkEvaluator` |

`harness` (the loop itself), `infra` and `interface` (CLI, HTTP, MCP server) have no adapter contract; they appear as
`Layer` values on spans, tools and evaluation scores.

## How layers meet in a run

| Layer | Hook in the loop | Event |
|---|---|---|
| `knowledge` | `knowledge` middleware (`beforeModel`), `search_knowledge` tool | `knowledge_retrieval`; tool events with `layer: "knowledge"` |
| `tool` | executor | `tool_start` / `tool_result` (with `layer` from `Tool.layer`) |
| `identity` | `authorizeCall` (policy `when` rules, then the PDP) before every call | `tool_decision` (reasons `pdp: ...` from the PDP) |
| `guardrail` | `guard` middleware (`beforeInput`, `beforeModel`, `afterModel`, `beforeTool`, `afterTool`) | `guardrail`; run end `guardrail:<guard>:<stage>` |
| `cache` | `responseCache` provider wrapper, router middleware | `model_request` / `model_response` (`model` is the routed spec) |
| `telemetry` | sinks | all events; `EVENT_LAYERS` maps layer events to span events |
| `eval` | after the run, on the event log | `layerSignals` reads the events above |
