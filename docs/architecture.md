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
| Kernel: types, loop, state fold, policy, budgets, executor, compaction | `types.ts`, `loop.ts`, `state.ts`, `policy.ts`, `tools/executor.ts`, `compaction.ts` | nothing |
| Adapters: providers, stores, sinks, MCP, workspace tools, cache, memory | `providers/`, `store/`, `observe/`, `mcp/`, `tools/`, `cache.ts` | kernel |
| Composition: subagents, teams, patterns | `subagent.ts`, `team.ts`, `patterns.ts` | kernel |
| Declarative: presets, agent files, config, registry, runtime, project | `presets.ts`, `agentfile.ts`, `frontmatter.ts`, `config/`, `registry.ts`, `project.ts` | all of the above |
| Interfaces: easy API, CLI, HTTP, MCP server, architect | `easy.ts`, `cli.ts`, `serve.ts`, `mcp/server.ts`, `architect.ts` | all of the above |

Every layer can be used without the ones above it. `stream(agentObject)` with a hand-built `Agent` needs no config,
registry or files.

## Events and state

The state of a run is a fold over its events (`state.ts: reduce`):

| Event | Persisted | Effect on state |
|---|---|---|
| `run_start` | yes | status = running |
| `message` | yes | appends an input or harness message |
| `model_response` | yes | appends the assistant message; adds usage and cost; sets the turn |
| `tool_decision` | yes | (audit) |
| `tool_result` | yes | appends a tool result |
| `compaction` | yes | replaces the history |
| `run_end` | yes | final status |
| `turn_start`, `model_request`, `text_delta`, `tool_start` | no | streaming and tracing only |

Persistence is awaited at checkpoints: after each model response and after each tool batch. Crash semantics:

- A crash while tools run: on resume, only calls without a `tool_result` are executed.
- A crash during a model call: the call is repeated, and nothing else is.
- A torn last line in the JSONL log is ignored; corruption in the middle is an error.
- If the store fails, the run stops at once (`failed`, `store: ...`) and nothing more is written, so the log stays a
  consistent prefix.
- Tools are executed **at least once**. A tool that finished just before a crash, but before its result was
  persisted, runs again on resume. Make side-effecting tools idempotent, or check their effect before acting.

A session is the same mechanism: `run(agent, input, { runId })` appends new input to the stored log and continues.

## Extension points

| Hook | Where |
|---|---|
| `Provider.generate(request, { signal, onText })` | one method; any model API |
| `Middleware.beforeModel/afterModel/beforeTool/afterTool` | rewrite requests, deny calls, redact outputs |
| `CompactionStrategy.compact(messages, ctx)` | context policy |
| `RunStore.append/load/list` | durability backend |
| `Sink.onEvent` | observability |
| `CacheStore.get/set` | response cache backend |
| `PatternDefinition` | new multi-agent patterns and roles |
| `Registry` | names every factory above for config and plugins |

## Design rules

- No hidden prompts. The only harness-authored texts are exported constants (`OUTPUT_FEEDBACK`,
  `DEFAULT_SUMMARY_PROMPT`, `TEMPLATES`), and each can be overridden.
- Append-only history keeps the prompt prefix stable for provider caching. Compaction is the only rewrite, and it is
  recorded as an event.
- Failures become data. Tool errors, invalid arguments, unknown tools and denials go back to the model as error
  results, and runs end with an explicit status and reason instead of throwing.
- Zero runtime dependencies: `fetch`, `node:*` and the code in this repository.
