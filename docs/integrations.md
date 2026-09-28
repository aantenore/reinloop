# Integrations: reuse, don't rebuild

## The problem

A working agent is the easy part. A complete agent system also needs knowledge (RAG), procedures (skills), memory,
caching, observability, evaluation, guardrails and deployment. Each of these already has mature, maintained
projects. The usual cost is glue: a different SDK, config style and upgrade cycle for each. Frameworks answer by
wrapping everything, which is where bloat and lock-in come from.

## The principle

reinloop connects existing technology through **open standards**, declared in the same files as the agents.

| Standard | What it connects |
|---|---|
| **MCP** | tools, data, RAG, memory, SaaS APIs, browsers |
| **Agent Skills** (`SKILL.md` folders) | procedures and know-how |
| **OpenAI-compatible HTTP** | models and LLM gateways |
| **OTLP** (OpenTelemetry GenAI conventions) | tracing backends |
| **HTTP / CLI** (`reinloop serve`, `--json`) | eval tools, apps, other languages |

`reinloop add <name>` writes the configuration for a vetted integration, and `reinloop validate` connects to it.

```bash
reinloop add            # list the catalogue
reinloop add qdrant     # adds mcpServers.qdrant to reinloop.json
```

Then give the tools to the agents that need them: `tools: [read_file, qdrant__*]`.

## Map

| Need | Reuse | In reinloop |
|---|---|---|
| Search your documents (RAG) | Qdrant, Chroma (official MCP servers); any vector DB with an MCP server | `reinloop add qdrant` / `chroma` |
| Search code or files | Agentic search (glob + grep + read) is often better than embeddings for code | built-in `find_files`, `search_files`, `read_file` |
| Procedures, playbooks, house style | Agent Skills folders you already have | `skills: [name]` in an agent file ([details](#skills)) |
| Long-term memory | Built-in notes, or the reference knowledge-graph MCP server | `remember` / `recall`, or `reinloop add memory-graph` |
| Web, GitHub, git, browser | Reference and vendor MCP servers | `reinloop add fetch` / `github` / `git` / `playwright` |
| Many providers, fallbacks, spend limits, org guardrails | LiteLLM proxy (or any OpenAI-compatible gateway) | `reinloop add litellm`, then `model: litellm/<name>` |
| Tracing and cost analytics | Any OTLP backend: Collector, Jaeger, Tempo, Langfuse, Datadog, Honeycomb | `reinloop add otel` / `langfuse` |
| Evals and regression tests | promptfoo (HTTP provider against `reinloop serve`) | `reinloop add promptfoo` |
| Guardrails on inputs and outputs | A gateway's guardrails, or a middleware that calls your classifier | `middleware: [...]` from a plugin |
| Durable workflows across machines | Temporal, Restate, queues | run agents inside their activities; plug a DB-backed `RunStore` |

## What reinloop deliberately does not build

| Not built | Why | Use instead |
|---|---|---|
| Vector database, embeddings, chunking | Mature products exist, and quality depends on your data | Qdrant/Chroma/pgvector plus their loaders, LlamaIndex, Unstructured |
| Ingestion pipelines | MCP servers query and store, but bulk ingestion is a separate batch job | the vector DB's clients or loaders; for small sets, the server's store tool |
| Eval platform | Test runners, graders and dashboards already exist | promptfoo, Langfuse datasets, your CI |
| Guardrail models | Safety classifiers are a model problem | gateway guardrails, or a classifier called from middleware |
| Semantic response cache in the agent loop | Unsafe for agents (see below) | exact-match `responseCache`; semantic caching at a gateway for stateless Q&A |

## Caching strategy

| Layer | Use | Status |
|---|---|---|
| Provider prompt caching | Always. Append-only history and a stable tool catalogue keep the prefix cacheable; Anthropic breakpoints are added automatically, OpenAI caches on its own. | built in |
| Exact response cache | Development, tests, evals, deterministic pipelines. Identical requests replay at zero cost. | `responseCache` (memory/file/plugin) |
| Semantic response cache | Only at the **entry** of stateless, repetitive Q&A (FAQ bots), with a high threshold, per-tenant namespaces and TTL, at a gateway | not in the loop, by design |

Why no semantic cache inside the loop: in multi-turn agent traffic, consecutive turns have near-identical
embeddings (about 0.99). A similarity hit then replays a stale answer and the agent repeats an old tool call, and
raising the threshold does not fix it. LiteLLM documents exactly this and recommends exact-match caching for agents
([LiteLLM](https://docs.litellm.ai/docs/proxy/caching_semantic)). Portkey warns that a wrong hit in a multi-step
workflow corrupts every later step ([Portkey](https://portkey.ai/blog/reducing-llm-costs-and-latency-semantic-cache/)).
Redis reports a cross-tenant leak with a 0.88 threshold and a global namespace
([Redis](https://redis.io/blog/what-is-semantic-caching/)). For an agent with tools, a wrong hit is a wrong
**action**, not just a wrong answer. The research direction for agents is caching *plans* and adapting them at run
time ([Agentic Plan Caching](https://arxiv.org/abs/2506.14852)), not caching responses.

## Skills

reinloop reads the open Agent Skills format: a folder with `SKILL.md` (frontmatter `name`, `description`) plus
optional resources and scripts. It discovers skills in `skills/` and `.reinloop/skills/`, in `skillsDir`, or in a
directory passed with `--skills <dir>`. Skills written for other tools work unchanged, with any model.

```markdown
---
description: Prepares release notes
skills: [release-notes, brand-*]
tools: [read_file, shell]
---
```

Disclosure is progressive. The agent gets one `skill` tool whose description lists only names and descriptions.
Loading a skill returns its instructions and file list, and `file=<path>` loads a bundled resource. Scripts run
through the `shell` tool, so policy and approvals apply.

## Observability

```json
"sinks": [{ "type": "otlp", "endpoint": "http://localhost:4318", "headers": { "authorization": "Bearer ${env:OTEL_TOKEN}" } }]
```

Spans follow the GenAI semantic conventions: `invoke_agent`, `chat`, `execute_tool`, with token usage, model and
finish reason. Content is not recorded unless you set `captureContent: true`. Export uses OTLP/HTTP with JSON; for
backends that only accept protobuf, use an OpenTelemetry Collector.

## Evals

`reinloop add promptfoo --agent <name>` writes a `promptfooconfig.yaml` that calls the agent through
`reinloop serve`. Assertions, LLM rubrics, datasets and CI reporting come from promptfoo. For fast, free and
repeatable regression runs, turn on the exact `responseCache` in a `ci` profile.

## Status of the catalogue

Run live on 2026-09-28 with `npm run live:integrations` (plus promptfoo and LiteLLM by hand), on macOS, Node 24,
uv 0.11:

| Entry | Live result |
|---|---|
| `chroma` | create collection, add documents, semantic query returns the right document |
| `qdrant` | local embedded mode (`QDRANT_LOCAL_PATH`): store and semantic find. Needs Python 3.12: the entry pins it, because a native dependency had no wheel for the newest Python. |
| `memory-graph` | create entities, read graph |
| `fetch` | fetches and converts a page to Markdown |
| `git` | reads the log of this repository |
| `playwright` | connects and lists 25 tools (browser actions not exercised) |
| `litellm` | reinloop → LiteLLM proxy → Ollama: a tool-using agent answered correctly |
| `promptfoo` | the generated config evaluates an agent through `reinloop serve`: 1/1 passing |
| `github`, `langfuse` | not run: they need your credentials |
| `otel` | covered by tests against a local OTLP receiver; no external collector run |

Run `npm run live:integrations [name ...]` to repeat the check on your machine. Each entry links its upstream
source.
