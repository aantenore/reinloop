# Changelog

## Unreleased

## 0.3.0 - 2026-10-31

Layer hooks, configurable limits and security hardening. Highlights: run identity and credentials, policy `when` and
the PDP hook, `guardMiddleware` / `knowledgeMiddleware` hooks, MCP per-call auth, layer-tagged telemetry and OTLP
metrics, configurable limits and timeouts. Layer implementations live in agent-layers. Breaking: a `0` timeout is
replaced by `"unbounded"`, and removed config keys fail with a pointer to agent-layers.

Layer hooks. Layer implementations were first added here (OIDC verifier and token exchange, OPA and AuthZEN
authorizers, Presidio / LLM Guard / HTTP / regex guards, MCP / HTTP / wiki knowledge sources, declarative HTTP tools and
OpenAPI import, a rule router, evaluation with replay and the `eval` / `replay` CLI, conformance kits for them) and then
moved to [agent-layers](https://github.com/aantenore/agent-layers) as adapters before release. reinloop keeps the
runtime and the hooks they plug into; see [docs/layers](docs/layers/README.md).

- Contracts: `Layer`, `Identity`, `IdentityVerifier`, `CredentialProvider`, `CredentialFactory`, `Authorizer`
  (`AccessQuestion` in agent-layers names), `KnowledgeSource`, `Guard`, `ModelRouter`, `Evaluator`; `Tool.layer`.
- Run identity: `identity` / `credentials` in `RunOptions`, `ToolContext` and `HookContext`, inherited by subagents;
  subject and kind on `run_start`, never the token.
- Policy: rules with `when` (roles, scopes, kind); external PDP hook `policy.pdp` (`authorizer` in code, or `type`
  resolved through `registry.authorizers`) via `authorizeCall`, with `onError`, `includeArgs`, `maxReasonChars`.
- Identity config: `identity.verifier` / `identity.credentials` resolved through `registry.verifiers` /
  `registry.credentials` (no built-in type; `type` is required). `reinloop serve` verifies bearer tokens with any
  `IdentityVerifier`, isolates runs per subject and answers RFC 6750 challenges. MCP servers take per-call `auth` from
  the run credentials; connection setup uses the factory without identity.
- Middleware: `beforeInput` (redacted input is what is persisted), `holdsText` (no unchecked streamed text),
  `HookContext.emit`; `RunStop` ends a run `stopped`; answers rejected in `afterModel` still count toward usage and
  cost. `guardMiddleware` runs any `Guard` objects at four stages (persisted `guardrail` event); `knowledgeMiddleware`
  appends cache-friendly retrieval from any `KnowledgeSource` (persisted `knowledge_retrieval` event). Registry
  factories get `FactoryContext.onClose`.
- Model access: `routedModel` / `withRouter`; config `routers` (resolved through `registry.routers`) and agent
  `router`. Routed responses are priced with the selected model (`ModelResponse.pricing`, `responseCost`).
- llm: `checkProvider` and `checkOpenAIEndpoint` conformance checks.
- MCP: per-call tokens and static header secrets are masked in tool results, structured content and errors (also
  JSON-escaped and before truncation); `limits.minSecretChars` sets the shortest masked secret.
- Telemetry: `agent.layer` on spans, events of other layers as span events (`EVENT_LAYERS`, `eventLayers`), `layer` on
  `tool_start` / `tool_result`, OTLP metrics (`otlpMetricsSink`, `"metrics": true`).
- Config: the sections `knowledge`, `guardrails`, `httpTools` and `openapi` are rejected with a pointer to agent-layers.
- Limits: every timeout, size, count and cap is declared once in `LIMITS` (`src/limits.ts`: default, config path,
  accepted and safe range) and is a config field plus a code option. New config fields under `tools`, `web`, `signals`,
  `mcpServers`, `providers`, `memory`, `policy.pdp`, `sinks` (otlp) and new sections `serve` and `limits`. Limits take `${env:NAME}` (numbers checked after interpolation) and, where it
  makes sense, `"unbounded"`; out-of-range values are rejected, and unsafe ones raise a `ReinloopConfigWarning` at load
  (`loadConfig().warnings`, `onWarning`). Defaults are unchanged. A `0` timeout is no longer accepted in the config
  (use `"unbounded"`). Docs: the Limits section of `docs/configuration.md`.
- Docs: `docs/architecture.md` gains a public API reference covering every export of `src/index.ts` and a complete event
  table (`tool_args_invalid`, `hosted_tool_*`); `docs/configuration.md` lists the remaining schema keys (`readOnly`,
  `limitParam`, `web.maxUses`, `web.topic`, agent `budget` / `params` / `asTool` fields, `$schema`).
- Anthropic streaming: malformed `tool_use` input JSON no longer fails the run. Syntax damage (trailing commas,
  unclosed objects/arrays, dangling key) is repaired and the call runs; values cut off mid-way are not completed and
  the call gets a tool error asking for valid JSON, so the model retries next turn. New event `tool_args_invalid`
  (`repaired`), `usage.toolArgsInvalid` and `ToolCallPart.argsIssue`.
- Docs: thinking summaries have no language setting in the API; `thinking.display: "omitted"` or `type: "disabled"`
  keeps them out of UIs and logs.
- Public signal tools: `signalTools({ sources?, maxResults?, cacheTtlMs?, timeoutMs?, githubToken?, fetchImpl? })`
  returns `search_discussions` (Hacker News via Algolia), `search_projects` (GitHub repositories, optional issues),
  `search_questions` (Stack Overflow) and `search_papers` (arXiv, Atom parsed without dependencies), all risk `read`.
  Results are compact JSON with `untrusted: true`, `source` and `retrieved_at`; optional TTL cache, per-request
  timeout, a descriptive User-Agent, and rate limits returned as clear tool errors. Custom backends implement
  `SignalSource`. Config section `signals`. See docs/signal-tools.md.
- **Breaking (behaviour):** `web_fetch` now only accepts URLs returned by `web_search` earlier in the same run
  (new option `fetchPolicy: 'search-results' | 'any' | 'off'`, default `search-results`; config `web.fetchPolicy`).
  This blocks prompt-injection exfiltration through attacker URLs. Set `fetchPolicy: 'any'` to restore the old
  behaviour, or `'off'` to drop the tool. Search-only flows are unaffected.
- In every `fetchPolicy`, `web_fetch` refuses non-http(s) URLs, credentials in the URL, IP-literal hosts,
  localhost / private / link-local targets, `*.local` / `*.internal` names and URLs longer than `maxUrlLength`
  (default 512); fragments are stripped. Refusals are returned as tool errors. New export `checkFetchUrl`.
- Provider-hosted tools: `hostedTool({ provider, type, name?, params?, risk?, beta? })` declares a tool the provider
  runs inside the model turn (Anthropic `web_search_*`, `web_fetch_*`, `code_execution_*`). It is sent verbatim in the
  request and never executed by the loop. `server_tool_use` and `*_tool_result` blocks become `hosted_call` /
  `hosted_result` parts kept in the history (echoed unchanged, so multi-turn and thinking replay keep working, also
  when streaming); text citations are kept on text parts. New ephemeral events `hosted_tool_start` and
  `hosted_tool_result` (summary, error flag, sources). `pause_turn` is a new stop reason: the loop sends the paused
  turn back so the provider resumes it. Chat Completions providers reject hosted tools (Anthropic only for now).
- Hosted calls count against `maxToolCalls`, and `max_uses` of web search/fetch is capped to the remaining budget.
  The policy applies once per run before the tool is offered: web search/fetch default to risk `read`, other hosted
  tools (e.g. code execution) to `exec`, so they are dropped without an approver unless a rule allows them.
- `Usage.serverToolUse` (e.g. `{ webSearchRequests: 2 }`) and `Pricing.serverToolUsd` (USD per request): built-in
  Claude prices include web search at $0.01 per request; override per model in the `pricing` config section.
- `webTools({ provider, ... })`: `web_search {query, max_results?}` and `web_fetch {url}` (risk `read`) with the
  `tavily`, `anthropic-native` or a custom `WebProvider` backend. Results are compact JSON marked `untrusted: true`,
  truncated (`maxChars`, `maxFetchChars`), optionally cached in memory (`cacheTtlMs`).
- Config: `hostedTools.<name>` and `web` sections; `web_search` / `web_fetch` are built-in tool names for agents and
  agent files. `mockProvider` turns accept `parts` and `stopReason`.
- Anthropic prompt caching is on by default for `anthropic(...)` (it already was for `anthropic/...` presets):
  breakpoints on the tool catalog, the system prompt and the latest message (rolling, never on thinking blocks),
  each skipped when its prefix is below `cacheMinTokens` (default 1024). `params.cache` and
  `params.cacheTtl: '5m' | '1h'` set it per agent; provider options `cache`, `cacheTtl`, `cacheMinTokens`.
- Cache cost: `Usage.cacheWrite1hTokens` (from `cache_creation.ephemeral_1h_input_tokens`) and
  `Pricing.cacheWriteMultiplier` / `cacheWrite1hMultiplier`; built-in Claude prices charge writes at 1.25x (5m) and
  2x (1h) the input price, reads at `cacheReadPerMTok`. Previously writes were charged at the plain input price.

## 0.2.0 - 2026-10-24

- The MCP client and server report the package version instead of a fixed `0.1.0`.
- `McpToolInfo` (returned by `McpClient.listTools()`) is exported from the package entry.
- `sonnet` and `haiku` aliases and the default model for `ANTHROPIC_API_KEY` now point to `claude-sonnet-5-5` and
  `claude-haiku-5-5`.
- Structured output reaches the model also when the agent has tools: Anthropic gets `output_config.format`
  (merged with any `output_config` from `params.extra`, objects closed with `additionalProperties: false`), and
  OpenAI-compatible providers keep `response_format`. Local presets (`ollama`, `lmstudio`, `vllm`) use the new
  `structuredOutput: "without-tools"` mode.
- Built-in prices for `claude-opus-5-5`, `claude-sonnet-5-5` and `claude-haiku-5-5`, and a top-level `pricing`
  config section with per-model overrides merged over the built-in table.
- Team results and their `run_end` event carry optional `failures` (`{ name, status, reason, runId }` per member run
  that did not complete, including budget-stopped ones) for `parallel`, `chain`, `router`, `evaluator` and
  `orchestrator`; nested teams are flattened, also when the nested team itself completed (e.g. an evaluator whose
  generator is a `parallel` team with a stopped worker).
  `MemberFailure` and `memberFailures` are exported, and `agentTool` accepts `onResult`.
- Tools can end the run: returning `{ content, stop: true, data? }` completes the run after the current batch without
  another model turn (first stop in call order wins, error results never stop, `data` validated against the output
  schema). The stop is persisted with `tool_result`, so resume is consistent.
- Built-in presets can send extra headers: `presets.<name>.headers` in config, and env-to-header mappings declared
  per preset (`ANTHROPIC_WORKSPACE_ID` becomes `anthropic-workspace-id` for `anthropic/...`).
- `MemoryStore` accepts an optional `search(namespace, query, limit)`; `recall` uses it when present (keeping its
  order) and falls back to keyword-overlap ranking of `all()` otherwise.
- MCP servers accept `prefix: false` (or `""`) to expose tools under the server's own names instead of
  `<prefix>__<tool>`; the default prefix (the server name) is unchanged.
- Opt-in `forwardEvents` for delegated runs (`agentTool`, `asTool`, orchestrator option): their events, tagged with
  `parentRunId`, also flow into the parent's stream. Default off: they reach only sinks and store, as before.
- Frontmatter accepts flow mappings and sequences spread over several lines (`- {code: x,` / `name: y}`); the
  supported YAML subset is documented in `docs/agent-files.md`.
- Anthropic thinking blocks are no longer dropped: they are kept as `thinking` parts (with signature or redacted data)
  and echoed back unchanged. A `max_tokens` stop without text or tool calls (e.g. a reasoning-only answer) ends the run
  as `stopped` / `max_tokens` instead of being retried as an "empty response"; an empty `refusal` (new stop reason)
  ends it as `failed` / `refusal`.
- First-class `params.thinking` (`type`, `budgetTokens`, `display`) and `params.effort` for Anthropic, merged with the
  structured output `output_config`; known per-model restrictions of the 5.5 models (`THINKING_RULES`) fail before
  the request. Reasoning streams as `thinking_delta` events. Optional `params.retryMaxTokens` repeats a `max_tokens`
  stop once with a higher limit (off by default).
