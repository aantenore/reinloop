# Architecture

```
agent files / reinloop.json ──► config loader ──► registry factories ──► Agent | Team objects
                                                                            │
                        CLI · HTTP/SSE · MCP · your code ──► stream()/run() ┤
                                                                            ▼
                         ┌──────────────────────── the loop (src/loop.ts) ─────────────────────┐
                         │ pending tool calls? → policy → approve → validate → run (parallel)   │
                         │ last message from the model? → check output schema → done           │
                         │ budget → compaction → middleware → provider.generate → event        │
                         └──────────────────────────────────────────────────────────────────────┘
                                         │ every step is an event
                     store (append-only log) · sinks (console, JSONL, OTel) · handle (async iterable)
```

## Layers

| Layer | Files | Depends on |
|---|---|---|
| Kernel: types, loop, state fold, policy, budgets, executor, compaction | `types.ts`, `loop.ts`, `state.ts`, `policy.ts`, `stop.ts`, `tools/executor.ts`, `identity/authorize.ts`, `compaction.ts` | nothing |
| Adapters: providers, stores, sinks, MCP, workspace/HTTP/OpenAPI tools, cache, router, memory, knowledge, identity, guardrails, evaluation | `providers/`, `store/`, `observe/`, `mcp/`, `tools/`, `cache.ts`, `router.ts`, `rule-router.ts`, `knowledge/`, `identity/`, `guardrails/`, `eval/` | kernel (contract types only, where noted in each layer page) |
| Conformance checks | `conformance/` | contract types |
| Composition: subagents, teams, patterns | `subagent.ts`, `team.ts`, `patterns.ts` | kernel |
| Declarative: presets, agent files, config, registry, runtime, project | `presets.ts`, `agentfile.ts`, `frontmatter.ts`, `config/`, `registry.ts`, `project.ts` | all of the above |
| Interfaces: easy API, CLI (incl. `eval`, `replay`), HTTP (optional OIDC bearer auth), MCP server, architect | `easy.ts`, `cli.ts`, `eval/cli.ts`, `serve.ts`, `mcp/server.ts`, `architect.ts` | all of the above |

Every layer can be used without the ones above it. `stream(agentObject)` with a hand-built `Agent` needs no config,
registry or files.

### Platform layers

The code layers above host the adapters of the platform layers (`Layer` in `types.ts`): `llm`, `cache`, `knowledge`,
`tool`, `identity`, `guardrail`, `telemetry`, `eval`, plus `harness`, `infra` and `interface`. Each has a contract, reference
adapters, a conformance check and a page; the index is [layers/README.md](layers/README.md).

## Events and state

The state of a run is a fold over its events (`state.ts: reduce`):

| Event | Persisted | Effect on state |
|---|---|---|
| `run_start` | yes | status = running (`parentRunId` set for delegated runs) |
| `message` | yes | appends an input or harness message |
| `model_response` | yes | appends the assistant message; adds usage and cost (priced with `ModelResponse.pricing` when a router set it); sets the turn (`discarded: true`: accounted, kept out of the history, e.g. `retryMaxTokens`, or an answer rejected in `afterModel` such as a guardrail block, recorded with an empty message) |
| `tool_decision` | yes | (audit; PDP reasons start with `pdp:`) |
| `tool_args_invalid` | yes | malformed streamed tool arguments (`repaired` or answered with a tool error); counted in `usage.toolArgsInvalid` |
| `knowledge_retrieval` | yes | (audit) `{ source, query, passages, ids, durationMs, error? }`: which passages informed a model call (ids only, no text) |
| `guardrail` | yes | (audit) `{ guard, stage, action, reason? }` for every block, redaction and guard error; never the inspected text |
| `hosted_tool_start`, `hosted_tool_result` | no | provider-hosted tool ran inside the model turn; derived from the response, the `hosted_call` / `hosted_result` parts are what persists |
| `tool_result` | yes | appends a tool result; records a `stop` request; `layer` from `Tool.layer` (also on `tool_start`) |
| `compaction` | yes | replaces the history |
| `run_end` | yes | final status; clears stop requests; team runs carry `failures` |
| `turn_start`, `model_request`, `text_delta`, `thinking_delta`, `tool_start` | no | streaming and tracing only (`text_delta` arrives once, after `afterModel`, when a middleware sets `holdsText`) |

Persistence is awaited at checkpoints: after each model response and after each tool batch. Crash semantics:

- A crash while tools run: on resume, only calls without a `tool_result` are executed.
- A crash during a model call: the call is repeated, and nothing else is.
- A torn last line in the JSONL log is ignored; corruption in the middle is an error.
- If the store fails, the run stops at once (`failed`, `store: ...`) and nothing more is written, so the log stays a
  consistent prefix.
- Tools are executed **at least once**. A tool that finished just before a crash, but before its result was
  persisted, runs again on resume. Make side-effecting tools idempotent, or check their effect before acting.

### Tools that end the run

A tool may return `{ content, stop: true, data? }`. The rest of that batch still runs, then the run ends `completed`
(reason `tool:<name>`) without another model turn. Its `output` is the tool's `content` and its `data` is the tool's
`data`. With several stopping calls in one batch, the first in the model's call order wins. Error results (including
those turned into errors by middleware) never stop the run. The request is part of the persisted `tool_result`, so a
run that crashed after the batch resumes straight to the end; `data` must therefore be JSON-serializable.

With an `output` schema, `data` (or `content` parsed as JSON when there is no `data`) is validated. A mismatch fails
the run (`invalid structured output from tool <name>: ...`) with no retry, because the model is no longer asked.

A session is the same mechanism: `run(agent, input, { runId })` appends new input to the stored log and continues.

## Public API

Everything below is exported from `reinloop` (`src/index.ts`). The easy layer (`agent`, `team`, `tool`) is enough for
most code; the rest is the lower layers.

| Area | Exports |
|---|---|
| Types | all of `types.ts` (`Agent`, `Tool`, `Provider`, `RunEvent`, `EventMap`, `Usage`, `Pricing`, ...) via `export type *` |
| Loop and state | `run`, `stream`, `createHandle`, `RunHandle`, `createEmitter`, `contextTokens`, `costOf`, `responseCost`, `OUTPUT_FEEDBACK`; `reduce`, `replay`, `pendingToolCalls`, `initialState`, `EPHEMERAL` |
| Policy and budgets | `decide`, `matchesCondition`, `mergePolicies`, `exceededBudget`, `DEFAULT_RISK_DECISIONS`, `DEFAULT_BUDGET`; `RunStop` |
| Compaction | `windowCompaction`, `summarizeCompaction`, `DEFAULT_SUMMARY_PROMPT` |
| Tools | `defineTool`, `objectSchema`, `safeToolName`, `memoryArtifacts`, `readArtifactTool`, `workspaceTools`, `resolveInside`, `pathGlob`, `WorkspaceOptions`; `memoryTools`, `memoryNotes`, `fileNotes`, `MemoryStore`, `Note`; `hostedTool`, `hostedRisk`, `HostedToolOptions`; `skillTool`, `discoverSkills`, `selectSkills`, `DEFAULT_SKILL_DIRS`, `Skill` |
| HTTP and OpenAPI tools | `httpTool`, `openapiTools`, `readOpenApiSpec` and their option types ([layers/tool.md](layers/tool.md)) |
| Web and signals | `webTools`, `checkFetchUrl`, `tavilyProvider`, `anthropicWebProvider`, `UNTRUSTED_NOTE` and the `Web*` option types ([web-tools.md](web-tools.md)); `signalTools`, `hackerNewsSource`, `githubSource`, `stackExchangeSource`, `arxivSource`, `parseArxivAtom`, `SignalRateLimitError`, `BUILTIN_SIGNAL_SOURCES` and the `Signal*` types ([signal-tools.md](signal-tools.md)) |
| Providers | `openaiCompatible`, `anthropic`, `checkThinking`, `THINKING_RULES`, `mockProvider`, `withRetry`, `withFallback`, `DEFAULT_RETRY_ON`, `withResponseCache`, `memoryCache`, `fileCache` and their option types |
| Models and prices | `PRESETS`, `MODEL_ALIASES`, `defaultModel`, `resolveModel`, `splitModel`, `presetProvider`, `missingCredentials`; `PRICING`, `pricingFor`, `ANTHROPIC_SERVER_TOOL_USD` |
| Model access | `routedModel`, `withRouter`, `ruleRouter` and their option types; `checkProvider`, `checkOpenAIEndpoint` ([layers/cache.md](layers/cache.md), [layers/llm.md](layers/llm.md)) |
| Stores and sinks | `memoryStore`, `fileStore`, `fileArtifacts`; `consoleSink`, `jsonlSink`, `collectSink`, `otelSink`, `otlpSink`, `otlpMetricsSink`; `EVENT_LAYERS`, `EVENT_ATTR_KEYS`, `EVENT_CONTENT_KEYS`, `eventAttributes` ([layers/telemetry.md](layers/telemetry.md)) |
| Knowledge | `knowledgeMiddleware`, `knowledgeTool`, `mcpKnowledge`, `httpKnowledge`, `wikiKnowledge`, `retrieve`, `mergePassages`, `fitPassages`, `formatBlock`, `toPassage`, `hashId`, `parseMcpResult`, `splitMarkdown`, `KNOWLEDGE_NOTE`, `checkKnowledgeSource` ([layers/knowledge.md](layers/knowledge.md)) |
| Identity | `oidcVerifier`, `oidcCredentials`, `authorizeCall`, `accessRequest`, `authzenAuthorizer`, `opaAuthorizer`, `decodeJwt`, `rolesOf`, `scopesOf`, `defaultKind`, `IdentityError`, `JWS_ALGORITHMS`, `DEFAULT_ALGORITHMS`, `TOKEN_EXCHANGE_GRANT`, `ACCESS_TOKEN_TYPE`; `checkIdentityVerifier`, `checkCredentialProvider`, `checkAuthorizer` ([layers/identity.md](layers/identity.md)) |
| Guardrails | `guardMiddleware`, `httpGuard`, `presidioGuard`, `llmGuardGuard`, `regexGuard`, `REGEX_PATTERNS`, `luhn`, `ibanValid`, `parseVerdict`, `GUARD_STAGES`, `registerGuardrails`, `checkGuard` ([layers/guardrail.md](layers/guardrail.md)) |
| Evaluation | `evaluate`, `summarize`, `expectedEvaluator`, `judgeEvaluator`, `layerSignals`, `scoreLayers`, `JUDGE_SCHEMA`, `replayRuns`, `withOverrides`, `inputSegments`, `LAYERS`, `parseDataset`, `toJsonl`, `caseProblems`, `scoreProblems`, `checkEvaluator` ([layers/eval.md](layers/eval.md)) |
| MCP | `McpClient`, `mcpTools`, `MCP_PROTOCOL_VERSION`, `McpServerConfig`, `McpToolInfo` (client); `serveMcp`, `McpServeOptions` (server) |
| Composition | `agentTool`, `AgentToolOptions`; `isTeam`, `runMember`, `streamMember`, `streamTeam`, `memberFailures`; `BUILTIN_PATTERNS`, `TEMPLATES`, `createTeam`, `definePattern`, `fill`, `describeMembers` |
| Declarative | `loadConfig`, `checkConfig`, `interpolate`, `deepMerge`, `applyProfile`, `ConfigError`, `CONFIG_SCHEMA`; `createRuntime`, `loadRuntime`, `loadPlugins`; `Registry`, `createRegistry`; `parseAgentFile`, `loadAgentDir`, `withAgentFiles`, `TOOL_ALIASES`, `DEFAULT_AGENT_DIRS`; `parseFrontmatter`, `parseYaml`; `loadProject`, `DEFAULT_AGENT`, `CONFIG_FILE` |
| Interfaces | `agent`, `team`, `tool`, `paramsSchema`; `serve`; `architect`, `architectInstructions`, `design`, `validateProject`; `INTEGRATIONS`, `addIntegration`; `validate` (JSON Schema subset); `ReinloopError`, `ProviderError`, `userMessage`, `textOf`, `toolCallsOf` |
| Type names | Option and result types of the exports above: `OpenAICompatibleOptions`, `AnthropicOptions`, `MockTurn`, `MockStep`, `MockProvider`, `RetryOptions`, `ResponseCacheOptions`, `OtelSinkOptions`, `OtelTracer`, `OtelSpan`, `OtlpOptions`, `Factory`, `FactoryContext`, `HarnessConfig`, `AgentConfig`, `TeamConfig`, `RoleBinding`, `HostedToolConfig`, `WebConfig`, `SignalsConfig`, `Runtime`, `RuntimeOptions`, `AgentOptions`, `EasyAgent`, `EasyTeam`, `Runnable`, `Session`, `ToolExtras`, `TeamContext`, `TeamOutcome`, `RoleSpec`, `MemberInfo`, `PresetOverrides`, `ProviderPreset`, `ParsedFile`, `ProjectOptions`, `ServeOptions`, `Served`, `Integration`; config types `HttpToolConfig`, `OpenApiConfig`, `KnowledgeConfig`, `KnowledgeSourceConfig`, `GuardrailsConfig`; layer option types are listed in each layer page |

## Extension points

| Hook | Where |
|---|---|
| `Provider.generate(request, { signal, onText })` | one method; any model API |
| `Middleware.beforeInput/beforeModel/afterModel/beforeTool/afterTool` | rewrite input before it is recorded, rewrite requests, deny calls, redact outputs; `holdsText` holds streamed text until `afterModel` ran; `HookContext.emit` records events; throw `RunStop` to end the run `stopped` |
| `ModelRouter.select(req, ctx)` | pick the model per request (`routers`, agent `router`) |
| `KnowledgeSource.search(query)` | retrieval backend (`knowledge.sources`) |
| `IdentityVerifier`, `CredentialProvider`, `Authorizer` | inbound tokens, downstream tokens, external policy decision point (`policy.pdp`) |
| `Guard.check(input)` | guardrail backend (`guardrails.guards`) |
| `Evaluator.score(case, run)` | evaluation metric (`reinloop eval`) |
| `CompactionStrategy.compact(messages, ctx)` | context policy |
| `RunStore.append/load/list` | durability backend |
| `Sink.onEvent` | observability |
| `CacheStore.get/set` | response cache backend |
| `PatternDefinition` | new multi-agent patterns and roles |
| `Registry` | names every factory above for config and plugins (`routers`, `verifiers`, `credentials`, `authorizers`, `guards` included); `FactoryContext.onClose` releases what a factory opened |

## Design rules

- No hidden prompts. The only harness-authored texts are exported constants (`OUTPUT_FEEDBACK`,
  `DEFAULT_SUMMARY_PROMPT`, `TEMPLATES`), and each can be overridden.
- Append-only history keeps the prompt prefix stable for provider caching. Compaction is the only rewrite, and it is
  recorded as an event.
- Failures become data. Tool errors, invalid arguments, unknown tools and denials go back to the model as error
  results, and runs end with an explicit status and reason instead of throwing.
- Zero runtime dependencies: `fetch`, `node:*` and the code in this repository.
