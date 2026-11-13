# reinloop

[![npm](https://img.shields.io/npm/v/reinloop)](https://www.npmjs.com/package/reinloop)
[![license](https://img.shields.io/npm/l/reinloop)](LICENSE)

**Agents as files. Harness included.**

reinloop runs agents written as Markdown files, including the subagent files you already keep for other tools,
headless on any model: in a terminal, a script, CI, an HTTP server or an MCP client. The harness that production
agents need is already there: budgets, approvals, crash-safe resume, OpenTelemetry tracing, context compaction,
parallel tools, MCP, retries, caching and multi-agent patterns. It has zero runtime dependencies and a loop you can
read in five minutes.

It is for you if you want agents that live in git as reviewable text, run the same on a local Ollama model and a
hosted one, and stop at a hard limit instead of a surprise bill.

| | reinloop | A typical agent framework |
|---|---|---|
| An agent is | a Markdown file you diff, review and run with one command | code that builds an object graph |
| Limits, approvals, resume, tracing | configuration, with safe defaults | libraries to pick and code to write |

How it compares with the alternatives, including where they win: [docs/why-simple.md](docs/why-simple.md).

```bash
npm i -g reinloop        # Node >= 22.18
npx reinloop --help      # or try it without installing
```

From source: `git clone https://github.com/aantenore/reinloop && cd reinloop && npm install && npm run build && npm link`.

## 60 seconds

```bash
mkdir my-agents && cd my-agents
reinloop new researcher                          # writes agents/researcher.md
REINLOOP_MODEL=mock/echo reinloop run "hi"       # keyless check with the offline echo model
reinloop run "What does this folder contain?"
```

Without a `model` in the file, reinloop uses `REINLOOP_MODEL`, else the first provider whose key is set
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`), else the local Ollama model
`ollama/qwen3:8b`: run `ollama pull qwen3:8b`, or `export REINLOOP_MODEL=ollama/<a model you have>`. A hosted model
without its key stops before the first request with the variable to set. `reinloop --version` prints the version;
[Troubleshooting](#troubleshooting) covers the first-run errors.

`agents/researcher.md` after editing the template:

```markdown
---
description: Answers questions about the files in this folder
model: openai/gpt-5-mini          # or anthropic/…, gemini/…, ollama/…, openrouter/…; omit for the default above
tools: [read_file, find_files, search_files]
budget: { maxTurns: 20 }
---
You are a precise researcher. Read the files before answering and cite paths.
```

That file is the whole agent. The body is the prompt. The frontmatter lists its tools, model and limits. API keys
come from the usual environment variables (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, ...). Without any agent file,
`reinloop run "..."` still works with a read-only default assistant.

Agent files follow the common subagent format (`name`, `description`, `tools: Read, Grep, Bash`, `model: sonnet`),
so agents you already wrote for other tools run here on **any** model: `reinloop run --agents <their folder> -a reviewer "..."`.
See [docs/agent-files.md](docs/agent-files.md#agent-files-from-other-tools) for mapping `model: sonnet` to a local model.

## Multi-agent in one file

A file with a `pattern` defines a team. Teams run, stream, nest and delegate exactly like agents.

```markdown
---
pattern: evaluator
roles: { generator: coder, evaluator: reviewer }
options: { maxRounds: 3 }
---
Implements a change and iterates until the independent reviewer approves it.
```

| Pattern | Roles | Use it for |
|---|---|---|
| `chain` | `steps[]` | Pipelines: outline → draft → edit |
| `parallel` | `workers[]`, `aggregator?` | Sectioning and voting, map-reduce |
| `router` | `router`, `routes[]` | Triage to specialists |
| `evaluator` | `generator`, `evaluator` | Quality loops: write → critique → revise |
| `orchestrator` | `orchestrator`, `workers[]` | A lead that plans and delegates |
| *yours* | *your roles* | Register a pattern from a plugin ([example](examples/custom-pattern/plugins/debate.mjs)) |

Any agent listed in another agent's `tools` becomes a delegate with an isolated context. See [docs/patterns.md](docs/patterns.md).

## Or describe it

```bash
reinloop create "a team that triages GitHub issues and drafts replies, with a reviewer that checks tone"
```

A built-in architect agent writes the agent and team files. It validates them and fixes its own errors. It can only
write inside `agents/`. The result is plain files you own, version and edit, not a canvas locked inside a tool.

## Connect what already exists

reinloop does not ship a vector DB, an eval platform or guardrail models. It connects the maintained ones through
open standards: MCP for tools, RAG and memory; Agent Skills for procedures; OpenAI-compatible gateways; OTLP for
tracing.

```bash
reinloop add            # catalogue: qdrant, chroma, memory-graph, fetch, git, github, playwright, litellm, otel, langfuse, promptfoo
reinloop add qdrant     # writes the MCP config; then give an agent  tools: [qdrant__*]
```

Skills in the open `SKILL.md` format are loaded on demand with `skills: [name]`. See [docs/integrations.md](docs/integrations.md),
which also explains what is deliberately not built and why (for example, why semantic caching stays out of the agent loop).

## Ecosystem

### The family

- **reinloop** is the runtime: agents as files, budgets, approvals, durable resume, OpenTelemetry, zero dependencies.
- **[agent-layers](https://github.com/aantenore/agent-layers)** is the eleven-layer SDK where reinloop is one runtime
  adapter (`@agent-layers/adapters/reinloop`).
- **[agent-plexus](https://github.com/aantenore/agent-plexus)** is multi-agent composition where an agent-layers stack
  is the host.
- **[Lorebase](https://github.com/aantenore/lorebase)** is the governed, versioned knowledge graph agents read over MCP.

### Layer integrations

reinloop provides the hooks; agent-layers provides the layers. reinloop keeps the contracts (`Identity`,
`IdentityVerifier`, `CredentialProvider`, `Authorizer`, `Guard`, `KnowledgeSource`, `ModelRouter`, `Evaluator`), the
places they plug in (run identity and credentials, policy `when` rules and the `policy.pdp` hook, `serve` bearer
verification, MCP per-call auth, `guardMiddleware`, `knowledgeMiddleware`, routed models, layer tags on OTLP spans and
metrics) and registry entries that plugins fill. Implementations such as OIDC, OPA/AuthZEN, Presidio, LLM Guard,
knowledge sources, HTTP/OpenAPI tools, rule routing and evaluation are agent-layers adapters in
`@agent-layers/adapters` (0.4.0 or later). See [docs/layers/README.md](docs/layers/README.md).

### Pi packages

The parts of this work that fill gaps in the [Pi](https://github.com/earendil-works/pi) ecosystem ship as Pi packages:
[`@aantenore/pi-otel`](https://github.com/aantenore/pi-otel) (OpenTelemetry for Pi; passes Pi's telemetry
conformance suite) and [`@aantenore/pi-budget`](https://github.com/aantenore/pi-budget) (hard USD, token, turn,
tool-call and time limits for Pi). Use reinloop for a standalone, zero-dependency runtime; use the Pi packages if you
already run Pi.

## Use them anywhere

```bash
reinloop chat -a researcher      # interactive session with memory of the conversation
reinloop serve                   # HTTP + SSE API and a small web console at http://127.0.0.1:7878
                                 # off-loopback --host needs --token (or an identity verifier) and --allow-host <name clients use>
                                 # routes and exposure rules: docs/configuration.md#serve
reinloop mcp                     # every agent/team becomes an MCP tool for IDEs and assistants
```

## In code

```ts
import { agent, team, tool } from 'reinloop';

const weather = tool('weather', 'Current weather', { city: 'string' }, ({ city }) => `Sunny in ${city}`);
const assistant = agent({ model: 'openai/gpt-5-mini', tools: [weather] });
const result = await assistant.run('Weather in Rome?');
if (result.status !== 'completed') throw new Error(result.reason);
console.log(result.output);

const reviewer = agent({ name: 'reviewer', instructions: 'Judge the answer.' });
const checked = team('checked', 'evaluator', { generator: assistant, evaluator: reviewer });
```

`run` resolves to a result with `status` (`completed`, `stopped`, `failed`, `interrupted`), `reason` when it did not
complete, `output`, parsed `data`, usage and cost; it does not throw on a model or tool failure. `stream` yields every event. `session()`
keeps a conversation going. The lower layer (`stream(agentObject)`, providers, stores, sinks, middleware) is public
too. See [docs/architecture.md](docs/architecture.md).

## What you get without writing code

| Need | How |
|---|---|
| Any model, no SDKs | `provider/model` strings: openai, anthropic, gemini, openrouter, groq, mistral, deepseek, xai, together, ollama, lmstudio, vllm; or any OpenAI-compatible URL |
| Safety | Tools carry a risk (`read`/`write`/`exec`); writes and commands ask for approval; ordered allow/deny/ask rules; workspace tools refuse path and symlink escapes |
| Cost control | Budgets per run: turns, tool calls, tokens, USD, time. The default is 50 turns. |
| Durability | Every run is an append-only event log. With `store: { type: file }` (the default `memory` store keeps nothing between commands) a crashed run resumes without re-running finished tools, and the same log keeps chat sessions. |
| Long tasks | Compaction (`window` or `summarize`); large tool outputs offloaded to artifacts with a paging tool |
| Speed | Parallel tool calls, streaming, ~30 ms cold import, ~30 µs kernel overhead per turn |
| Caching | Provider prompt caching (Anthropic breakpoints on by default, 5m/1h TTL, cache reads and writes priced in `costUsd`); optional response cache (memory/file, TTL) for dev, tests and evals |
| Memory | `remember` / `recall` tools with durable notes, shared or per agent; richer memory via MCP |
| Web | `web_search` / `web_fetch` tools (Tavily, Anthropic native search, or your own backend) with results marked untrusted; provider-hosted tools (Anthropic web search, web fetch, code execution) with policy, budgets and per-search cost. See [docs/web-tools.md](docs/web-tools.md) |
| Public signals | Keyless research tools over public APIs: `search_discussions` (Hacker News), `search_projects` (GitHub), `search_questions` (Stack Overflow), `search_papers` (arXiv), or your own source; compact, untrusted-marked, cached. See [docs/signal-tools.md](docs/signal-tools.md) |
| Skills | Open Agent Skills (`SKILL.md` folders), progressively disclosed |
| Structured output | JSON Schema validated with retries; sent natively (`response_format`, Anthropic `output_config.format`, also with tools) when the provider supports it; tolerant parsing |
| Tools | Built-ins (files, search, edit, shell), MCP servers (stdio/HTTP), your functions, other agents and teams |
| Observability | Typed events, console, JSONL traces, OTLP export with OpenTelemetry GenAI spans. Nothing leaves your machine unless you add a sink. |
| Extension | Plugins register providers, tools, patterns, stores, sinks, caches, compaction and middleware by name |

Configuration reference: [docs/configuration.md](docs/configuration.md). Agent file format: [docs/agent-files.md](docs/agent-files.md).
Models it has been run against, with results: [docs/models.md](docs/models.md).

## Why another agent framework?

It is deliberately not one. Practitioners consistently report the same failures: hidden loops and prompts, a
70-80% quality ceiling, dependency weight, lock-in, missing operational basics. The orchestration layer is
commoditised ([research](docs/research.md)). reinloop's bet is the opposite of a framework:

1. **The unit is a file, not a class.** Agents are portable, diffable, reviewable and editable by people and by agents.
2. **The harness is policy, not code.** Safety, budgets, durability and tracing are configured, not re-implemented.
3. **The loop stays yours.** Under 500 lines, every step an event and a hook, no hidden prompts. Copy it if you outgrow it.

An honest comparison with OpenAI Agents SDK, PydanticAI, LangGraph, CrewAI, Vercel AI SDK and Mastra, and with the
closer alternatives (fast-agent, Pi, Claude Agent SDK, Vercel Ash, opencode), including where they are better, is in
[docs/why-simple.md](docs/why-simple.md).

## Performance

`npm run bench` (Node 24, zero-latency mock model, one tool call per turn): cold import ~30 ms, kernel overhead ~30 µs
per turn in memory and ~1 ms with the durable JSONL log (fs append per event), 0 runtime dependencies. Model latency dominates by
orders of magnitude, so the harness is never the bottleneck.

## Status and limits

Version 0.x. The agent file format, config schema and event protocol are the contract, and planned breaking changes
bump the minor version. A security fix may change behaviour in a patch release (0.3.1 did, for `serve` and stdio MCP
servers); every such change is listed under "Changed" or marked "Breaking" in [CHANGELOG.md](CHANGELOG.md).
Current limits: text-only messages (no images or files), and teams do not resume mid-pattern
(member runs do). Token estimates before the first response are heuristic. The `shell` tool is confined to a
directory but is not a sandbox, so use a container for untrusted work. It needs a POSIX shell (`/bin/sh`): on Windows
run reinloop inside WSL; on native Windows a `shell` call returns a clear error and the other tools keep working.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `agent "x" uses openai/... but OPENAI_API_KEY is not set` before any request | Set the key, remove `model` to use the default, or `export REINLOOP_MODEL=<provider/model>`. `reinloop validate` lists every missing key. |
| `HTTP 404 ... model 'qwen3:8b' not found (hint: ollama pull qwen3:8b ...)` | The keyless default is `ollama/qwen3:8b`: `ollama pull qwen3:8b`, or `export REINLOOP_MODEL=ollama/<installed model>` (`ollama list`). |
| A write or `shell` call ends with `no approver configured` | Policy marks writes and commands `ask`. A terminal prompts; CI, pipes, `serve` and `mcp` have nobody to ask, so pass `-y`, or add a policy rule with `action: allow` for that tool ([agent-files.md](docs/agent-files.md)). |
| `nothing to resume: the default memory store keeps no run between commands` | Set `"store": { "type": "file" }` in `reinloop.json`; `resume`, `runs` and the `resume with:` hint need it. |
| Which version is installed? | `reinloop --version` (also `-v`, `reinloop version`). |
| `serve` answers `409 run busy` | Another request with the same `runId` is still running; wait for it, or use a new `runId`. |
| `serve` answers `403 host not allowed` | The `Host` clients use is not allowed: add it with `--allow-host <name>` (`serve.allowedHosts`), see [docs/configuration.md](docs/configuration.md#serve). |

## Why "reinloop"

*Rein* + *loop*. The agent loop stays yours, small and readable; you hold the reins through policy, budgets and approvals. Own the loop, hold the reins.

## Development

```bash
npm install
npm run check      # typecheck + tests (node:test, no network)
npm run build      # dist/ + schema/
npm run bench
```

Contributing and releases: [CONTRIBUTING.md](CONTRIBUTING.md). Reporting a vulnerability: [SECURITY.md](SECURITY.md).

MIT licensed.
