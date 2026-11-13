# Agent files

An agent is a Markdown file: frontmatter for settings, body for instructions. Files are discovered in `agents/` and
`.reinloop/agents/`, in `agentsDir` from the config, or in any directory passed with `--agents <dir>`. The file name
is the agent name unless `name` is set.

```markdown
---
description: Reviews pull requests for correctness bugs      # used for delegation, routing, listings
model: anthropic/claude-sonnet-5-5                               # optional, see "Models"
tools: [read_file, search_files, security-auditor]           # tools, MCP tools, other agents or teams
budget: { maxTurns: 30, maxCostUsd: 0.5 }
params: { temperature: 0 }
policy: { rules: [{ match: shell, action: deny }] }
compaction: { type: summarize, thresholdTokens: 48000 }
output:
  schema: { type: object, properties: { verdict: { enum: [approve, changes] } }, required: [verdict] }
middleware: [redact-secrets]
responseCache: false
---
You review code. Report only concrete defects with file and line.
```

| Field | Meaning |
|---|---|
| `description` | One line. Required for an agent to be picked by glob patterns in other agents' `tools`. |
| `model` | `provider/model`, a `models` alias from the config, `sonnet`/`opus`/`haiku`, or `inherit`. Omit it to use the default. |
| `tools` | List or comma-separated string. Globs are allowed (`fs__*`, `read_*`), as is `mcp:<server>`. |
| `budget` | `maxTurns`, `maxToolCalls`, `maxInputTokens`, `maxOutputTokens`, `maxTotalTokens`, `maxCostUsd`, `maxDurationMs`. A budget without `maxTurns` keeps the turn limit (`limits.maxTurns`, default 50): models without prices cost 0, so `maxCostUsd` alone never stops them. Runs the agent delegates to count against its cost, token and time limits ([architecture.md](architecture.md#budgets)). |
| `params` | `temperature`, `maxTokens`, `topP`, `stop`, `thinking` (`{ type: adaptive \| enabled \| disabled \| between_tools, budgetTokens, display: omitted \| summarized \| updates }`), `effort` (`low` ... `max`), `retryMaxTokens` (off by default: one repeat with this limit after a `max_tokens` stop), `extra` (provider-specific body fields). See [models](models.md#thinking-and-effort). |
| `policy` | `default`, `risk: { read, write, exec }`, `rules: [{ match, risk, action, reason }]`. |
| `compaction` | `{ type: window \| summarize \| <plugin>, thresholdTokens, ... }`. |
| `output` | `{ schema, retries }`: the final answer must be JSON matching the schema; parsed into `result.data`. |
| `middleware` | Names registered by plugins. |
| `asTool` | `{ name, description, context: fresh \| fork, forwardEvents }` to customise how other agents delegate to it (`forwardEvents: true` streams the delegated run's events to the caller). |
| `responseCache` | `false` to bypass the global response cache. |
| `skills` | Agent Skills (names or globs) the agent may load on demand; see [integrations.md](integrations.md#skills). |

## Models

Resolution order: a `models` alias in `reinloop.json`, then a short alias (`sonnet`, `opus`, `haiku`), then
`<provider>/<model>`, where the provider comes from the config's `providers` or the built-in presets:

| Preset | Key variable | Base URL override |
|---|---|---|
| `openai` | `OPENAI_API_KEY` | `OPENAI_BASE_URL` |
| `anthropic` | `ANTHROPIC_API_KEY` | `ANTHROPIC_BASE_URL` |
| `gemini` | `GEMINI_API_KEY` | |
| `openrouter`, `groq`, `mistral`, `deepseek`, `xai`, `together` | `<NAME>_API_KEY` | |
| `ollama`, `lmstudio`, `vllm` | `VLLM_API_KEY` (vllm only, optional) | `OLLAMA_BASE_URL`, `LMSTUDIO_BASE_URL`, `VLLM_BASE_URL` |
| `mock` | | Offline echo, handy for tests |

With no model anywhere, reinloop uses `REINLOOP_MODEL`. If that is unset, it picks the first provider whose key is set
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`), and falls back to the local Ollama model
`ollama/qwen3:8b`. `run`, `resume`, `chat` and `serve` stop before the first request when a preset's key is missing
(`validate` lists them), and a `404` from Ollama, LM Studio or vLLM for an unknown model says how to load it
(`ollama pull <model>`, or `REINLOOP_MODEL`).

## Built-in tools

| Tool | Risk | Notes |
|---|---|---|
| `read_file`, `list_dir`, `find_files`, `search_files` | read | Confined to the workspace; dependency and build folders are skipped by the finders |
| `write_file`, `edit_file` | write | Exact-snippet edits; must be unique unless `all: true` |
| `shell` | exec | Runs in the workspace root with a timeout |
| `remember`, `recall` | – | Durable notes (`memory` config) |
| `read_artifact` | read | Pages through large tool outputs that were offloaded |

Aliases from other agent-file formats are accepted: `Read`, `Write`, `Edit`, `MultiEdit`, `Bash`, `LS`, `Glob`,
`Grep`. Unknown fields such as `color` are ignored; any other unknown field is an error, to catch typos.

## Agent files from other tools

Folders of subagent files kept for other tools (a `.claude/agents` folder, for one) run headless here, without
copying: `reinloop run --agents .claude/agents -a reviewer "Review src/"`. `name`, `description`, `tools` (as a
comma-separated string, with the aliases above) and `model` are read; `color` is ignored; any other field is an error
(`reinloop validate --agents <dir>` lists them). Files in other shapes, for example with `mode` or a `tools` map, need
editing first.

`model: sonnet`, `opus` and `haiku` mean the Anthropic models and need `ANTHROPIC_API_KEY`. To run the same files on
another model, define the alias in `reinloop.json`; a `models` alias is resolved before the short ones:

```json
{
  "providers": { "local": { "type": "openai-compatible", "baseUrl": "http://localhost:11434/v1" } },
  "models": { "sonnet": { "provider": "local", "model": "qwen3:8b" } }
}
```

Files without `model` (or with `model: inherit`) use the default model, so `REINLOOP_MODEL` picks it.

## Teams

A file with `pattern` is a team; its body is the description. See [patterns.md](patterns.md).

```markdown
---
pattern: router
roles:
  router: { instructions: Classify the request., params: { temperature: 0 } }   # inline agent
  routes: [billing, tech-support]
options: { fallback: tech-support }
---
Sends each customer request to the right specialist.
```

## Frontmatter syntax

The accepted subset of YAML covers:

- `key: value` pairs and nested maps by indentation; `- item` lists, including `- key: value` items;
- flow collections (`[a, b]`, `{ a: 1 }`), nested and spread over several lines until the brackets close
  (`- {code: x,` / `name: y}`);
- plain scalars (`true`/`false`, `null`/`~`, numbers, otherwise strings), plain values folded over several deeper
  lines, single- and double-quoted strings (`''` and `\` escapes);
- `|` / `>` block scalars (with `-`) and `#` comments.

Anchors and aliases, tags, `?` complex keys, multi-line quoted strings and multi-document streams are not supported.
