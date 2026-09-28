# reinloop

**Agents as files. Harness included.**

reinloop is the smallest way to build an agent that is ready for real use. Write the agent as a Markdown file and run
it on any model. The harness that production agents need is already there: permissions, budgets, crash-safe resume,
context compaction, parallel tools, MCP, retries, caching, tracing and multi-agent patterns. It has zero runtime
dependencies and a loop you can read in five minutes.

```bash
npm i -g github:aantenore/reinloop     # Node >= 22.18
```

## 60 seconds

```bash
mkdir my-agents && cd my-agents
reinloop new researcher          # writes agents/researcher.md
reinloop run "What does this folder contain?"
```

`agents/researcher.md`:

```markdown
---
description: Answers questions about the files in this folder
model: openai/gpt-5-mini          # or anthropic/…, gemini/…, ollama/…, openrouter/…; omit to auto-detect
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

## Use them anywhere

```bash
reinloop chat -a researcher      # interactive session with memory of the conversation
reinloop serve                   # HTTP + SSE API and a small web console at http://127.0.0.1:8787
reinloop mcp                     # every agent/team becomes an MCP tool for IDEs and assistants
```

## In code

```ts
import { agent, team, tool } from 'reinloop';

const weather = tool('weather', 'Current weather', { city: 'string' }, ({ city }) => `Sunny in ${city}`);
const assistant = agent({ model: 'openai/gpt-5-mini', tools: [weather] });
console.log((await assistant.run('Weather in Rome?')).output);

const reviewer = agent({ name: 'reviewer', instructions: 'Judge the answer.' });
const checked = team('checked', 'evaluator', { generator: assistant, evaluator: reviewer });
```

`run` resolves to a result with status, output, parsed `data`, usage and cost. `stream` yields every event. `session()`
keeps a conversation going. The lower layer (`stream(agentObject)`, providers, stores, sinks, middleware) is public
too. See [docs/architecture.md](docs/architecture.md).

## What you get without writing code

| Need | How |
|---|---|
| Any model, no SDKs | `provider/model` strings: openai, anthropic, gemini, openrouter, groq, mistral, deepseek, xai, together, ollama, lmstudio, vllm; or any OpenAI-compatible URL |
| Safety | Tools carry a risk (`read`/`write`/`exec`); writes and commands ask for approval; ordered allow/deny/ask rules; workspace tools refuse path and symlink escapes |
| Cost control | Budgets per run: turns, tool calls, tokens, USD, time. The default is 50 turns. |
| Durability | Every run is an append-only event log. A crashed run resumes without re-running finished tools, and the same log keeps chat sessions. |
| Long tasks | Compaction (`window` or `summarize`); large tool outputs offloaded to artifacts with a paging tool |
| Speed | Parallel tool calls, streaming, ~30 ms cold import, ~20 µs kernel overhead per turn |
| Caching | Provider prompt caching (Anthropic breakpoints, stable prefixes); optional response cache (memory/file, TTL) for dev, tests and evals |
| Memory | `remember` / `recall` tools with durable notes, shared or per agent |
| Tools | Built-ins (files, search, edit, shell), MCP servers (stdio/HTTP), your functions, other agents and teams |
| Observability | Typed events, console, JSONL traces, OpenTelemetry GenAI spans. Nothing leaves your machine unless you add a sink. |
| Extension | Plugins register providers, tools, patterns, stores, sinks, caches, compaction and middleware by name |

Configuration reference: [docs/configuration.md](docs/configuration.md). Agent file format: [docs/agent-files.md](docs/agent-files.md).

## Why another agent framework?

It is deliberately not one. Practitioners consistently report the same failures: hidden loops and prompts, a
70-80% quality ceiling, dependency weight, lock-in, missing operational basics. The orchestration layer is
commoditised ([research](docs/research.md)). reinloop's bet is the opposite of a framework:

1. **The unit is a file, not a class.** Agents are portable, diffable, reviewable and editable by people and by agents.
2. **The harness is policy, not code.** Safety, budgets, durability and tracing are configured, not re-implemented.
3. **The loop stays yours.** About 200 lines, every step an event and a hook, no hidden prompts. Copy it if you outgrow it.

An honest comparison with OpenAI Agents SDK, PydanticAI, LangGraph, CrewAI, Vercel AI SDK and Mastra, including where
they are better, is in [docs/why-simple.md](docs/why-simple.md).

## Performance

`npm run bench` (Node 24, zero-latency mock model, one tool call per turn): cold import ~30 ms, kernel overhead ~20 µs
per turn in memory and ~1 ms with the durable JSONL log (fs append per event), 0 runtime dependencies. Model latency dominates by
orders of magnitude, so the harness is never the bottleneck.

## Status and limits

Version 0.x. The agent file format, config schema and event protocol are the contract, and breaking changes bump the
minor version.
Current limits: text-only messages, no passthrough of provider "thinking" blocks, and teams do not resume mid-pattern
(member runs do). Token estimates before the first response are heuristic. The `shell` tool is confined to a
directory but is not a sandbox, so use a container for untrusted work.

## Development

```bash
npm install
npm run check      # typecheck + tests (node:test, no network)
npm run build      # dist/ + schema/
npm run bench
```

MIT licensed.
