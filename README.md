# reinloop

[![npm](https://img.shields.io/npm/v/reinloop)](https://www.npmjs.com/package/reinloop)
[![license](https://img.shields.io/npm/l/reinloop)](LICENSE)

**Agents as files. Harness included.** A zero-dependency runtime that runs Markdown agent files headless on any
model, with budgets, permissions and resume built in.

## What it is

An agent is a Markdown file: the body is the prompt, the frontmatter names its model, tools and limits. reinloop runs
that file in a terminal, a script, CI, an HTTP server or an MCP client. The same file runs on a local Ollama model
and on a hosted one, and subagent files written for other tools run unchanged.

Three choices define it:

1. **The unit is a file, not a class.** Agents live in git as text people and agents can diff, review and edit.
2. **The harness is policy, not code.** Limits, approvals, durability and tracing are configured, with safe defaults.
3. **The loop stays yours.** Under 500 lines, every step an event and a hook, no hidden prompts, zero runtime
   dependencies.

## 60 seconds

```bash
mkdir my-agents && cd my-agents
npx reinloop new researcher                          # writes agents/researcher.md (Node >= 22.18)
REINLOOP_MODEL=mock/echo npx reinloop run "hi"       # keyless check with the offline echo model
npx reinloop run "What does this folder contain?"    # a real model
```

`npm i -g reinloop` installs the `reinloop` command used in the rest of this page. Without a `model` in the file,
reinloop uses `REINLOOP_MODEL`, else the first provider whose key is set (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`OPENROUTER_API_KEY`, `GEMINI_API_KEY`), else the local Ollama model `ollama/qwen3:8b` (`ollama pull qwen3:8b`). A
hosted model without its key stops before the first request and names the variable to set.
[Troubleshooting](#troubleshooting) covers the first-run errors.

## The file format

`agents/researcher.md` after editing the template:

```markdown
---
description: Answers questions about the files in this folder
model: openai/gpt-5-mini          # or anthropic/…, gemini/…, ollama/…, openrouter/…; omit for the default above
tools: [read_file, find_files, search_files]
budget: { maxTurns: 20, maxCostUsd: 0.5 }
---
You are a precise researcher. Read the files before answering and cite paths.
```

That file is the whole agent. Without any agent file, `reinloop run "..."` still works with a read-only default
assistant. Files in the common subagent format (`name`, `description`, `tools: Read, Grep, Bash`, `model: sonnet`)
run as they are: `reinloop run --agents <their folder> -a reviewer "..."`
([docs/agent-files.md](docs/agent-files.md#agent-files-from-other-tools)).

A file with a `pattern` is a team. Teams run, stream, nest and delegate exactly like agents:

```markdown
---
pattern: evaluator
roles: { generator: coder, evaluator: reviewer }
options: { maxRounds: 3 }
---
Implements a change and iterates until the independent reviewer approves it.
```

Built-in patterns are `chain`, `parallel`, `router`, `evaluator` and `orchestrator`; a plugin can register more
([example](examples/custom-pattern/plugins/debate.mjs)). Any agent listed in another agent's `tools` becomes a
delegate with an isolated context ([docs/patterns.md](docs/patterns.md)). `reinloop create "a team that triages
GitHub issues and drafts replies"` has a built-in architect agent write and validate the files for you.

## What it promises

**Budgets.** A run can be limited in turns (50 by default), tool calls, input, output and total tokens, USD and
time. Limits are checked before every model call, and the tool-call limit also inside a batch of calls. A run stops
at the first check after a limit is reached, with status `stopped` and reason `budget:<limit>`, so it can pass a
limit by at most the model call and tool batch that were in flight. Runs an agent delegates to count against its
cost and token limits and start with only what it has left; delegates called in one batch split that between them.
A USD limit needs a price for the model: a model without one (every local model) costs 0, the run says so in a
warning, and the turn limit is what stops it. Details and the cases that are not counted:
[docs/architecture.md](docs/architecture.md#budgets).

**Permissions.** Every tool carries a risk: `read` calls are allowed, `write` and `exec` calls ask for approval,
unless ordered allow/deny/ask rules say otherwise (the first matching rule wins). A terminal prompts; where nobody
can answer (CI, pipes, `serve`, `mcp`) an `ask` is a denial unless you pass `-y` or add an allow rule. Workspace
tools refuse path and symlink escapes. The `shell` tool is confined to a directory but is not a sandbox, so use a
container for untrusted work.

**Resume.** Every run is an append-only event log. With `store: { type: file }` (the default `memory` store keeps
nothing between commands), `reinloop resume <runId>` continues a crashed run: tool calls that have a stored result
are not run again, the ones without are. Tools therefore run at least once: one that finished just before the crash,
before its result was stored, runs again, so make side effects idempotent. A resumed crashed run keeps the budget it
already spent, turns and active time included. Continuing a run that ended (completed, failed, interrupted or
stopped by a limit) is a new session turn with the whole budget again. Teams do not resume mid-pattern; their member
runs do.

## Use it anywhere

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

## What else is in the box

| Need | How |
|---|---|
| Any model, no SDKs | `provider/model` strings: openai, anthropic, gemini, openrouter, groq, mistral, deepseek, xai, together, ollama, lmstudio, vllm; or any OpenAI-compatible URL |
| Long tasks | Compaction (`window` or `summarize`); large tool outputs offloaded to artifacts with a paging tool |
| Speed | Parallel tool calls, streaming, ~30 ms cold import, ~30 µs kernel overhead per turn |
| Caching | Provider prompt caching (Anthropic breakpoints on by default, 5m/1h TTL, cache reads and writes priced in `costUsd`); optional response cache (memory/file, TTL) for dev, tests and evals |
| Memory | `remember` / `recall` tools with durable notes, shared or per agent; richer memory via MCP |
| Web | `web_search` / `web_fetch` tools (Tavily, Anthropic native search, or your own backend) with results marked untrusted; provider-hosted tools (Anthropic web search, web fetch, code execution) with policy, budgets and per-search cost. See [docs/web-tools.md](docs/web-tools.md) |
| Public signals | Keyless research tools over public APIs: `search_discussions` (Hacker News), `search_projects` (GitHub), `search_questions` (Stack Overflow), `search_papers` (arXiv), or your own source; compact, untrusted-marked, cached. See [docs/signal-tools.md](docs/signal-tools.md) |
| Integrations | No vector DB, eval platform or guardrail model is bundled; the maintained ones connect through MCP, OpenAI-compatible gateways and OTLP. `reinloop add` lists the catalogue (qdrant, chroma, memory-graph, fetch, git, github, playwright, litellm, otel, langfuse, promptfoo) and `reinloop add qdrant` writes the MCP config. See [docs/integrations.md](docs/integrations.md) |
| Skills | Open Agent Skills (`SKILL.md` folders), loaded on demand with `skills: [name]` |
| Structured output | JSON Schema validated with retries; sent natively (`response_format`, Anthropic `output_config.format`, also with tools) when the provider supports it; tolerant parsing |
| Tools | Built-ins (files, search, edit, shell), MCP servers (stdio/HTTP), your functions, other agents and teams |
| Observability | Typed events, console, JSONL traces, OTLP export with OpenTelemetry GenAI spans. Nothing leaves your machine unless you add a sink. |
| Extension | Plugins register providers, tools, patterns, stores, sinks, caches, compaction and middleware by name |

Configuration reference: [docs/configuration.md](docs/configuration.md). Agent file format: [docs/agent-files.md](docs/agent-files.md).
Models it has been run against, with results: [docs/models.md](docs/models.md).

## How it compares

| Project | Where it wins | Where reinloop differs |
|---|---|---|
| [opencode](https://github.com/anomalyco/opencode) | Markdown agents on any model inside a widely adopted interactive tool; for interactive coding work it is the obvious first pick. | An embeddable runtime for non-interactive and backend use: CLI, HTTP and MCP server, code API, budgets and resume, not a terminal UI. |
| [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) | A mature agent loop, tools and context management with native support for the subagent Markdown format, tuned for Claude models. | Runs the same subagent files on any model, with budgets in USD, tokens and time and a provider-neutral OTLP export. |
| [LangGraph.js](https://github.com/langchain-ai/langgraphjs), [Mastra](https://github.com/mastra-ai/mastra) | Far more prebuilt connectors, larger communities and years of production use; LangGraph's graphs express arbitrary cycles over typed shared state, which reinloop's patterns do not. | Agents and teams are files, not code; limits, approvals, resume and tracing are configuration; zero dependencies. Breadth comes from MCP servers. |

The full comparison, with more projects and the trade-offs to weigh before choosing, is in
[docs/why-simple.md](docs/why-simple.md); the research behind the design is in [docs/research.md](docs/research.md).

## Using it inside agent-layers

reinloop is the harness layer of [agent-layers](https://github.com/aantenore/agent-layers), an SDK that puts
identity, guardrails, knowledge, routing and evaluation around an agent runtime; the adapter is
`@agent-layers/adapters/reinloop`. reinloop keeps the contracts and the hooks those layers plug into, agent-layers
ships the implementations, and nothing on this page needs it. The hooks are in
[docs/layers/README.md](docs/layers/README.md); the related projects, the layer integrations and the Pi packages are
in [docs/ecosystem.md](docs/ecosystem.md).

## Status and limits

Version 0.x. The agent file format, config schema and event protocol are the contract, and planned breaking changes
bump the minor version. A security fix may change behaviour in a patch release (0.3.1 did, for `serve` and stdio MCP
servers); every such change is listed under "Changed" or marked "Breaking" in [CHANGELOG.md](CHANGELOG.md).
Current limits: text-only messages (no images or files). Token estimates before the first response are heuristic.
The `shell` tool needs a POSIX shell (`/bin/sh`): on Windows run reinloop inside WSL; on native Windows a `shell`
call returns a clear error and the other tools keep working.

Overhead (`npm run bench`, Node 24, zero-latency mock model): cold import ~30 ms, ~30 µs per turn in memory and
~1 ms with the durable JSONL log.

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
