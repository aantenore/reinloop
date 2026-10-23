# Changelog

## Unreleased

- Structured output reaches the model also when the agent has tools: Anthropic gets `output_config.format`
  (merged with any `output_config` from `params.extra`, objects closed with `additionalProperties: false`), and
  OpenAI-compatible providers keep `response_format`. Local presets (`ollama`, `lmstudio`, `vllm`) use the new
  `structuredOutput: "without-tools"` mode.
- Built-in prices for `claude-opus-5-5`, `claude-sonnet-5-5` and `claude-haiku-5-5`, and a top-level `pricing`
  config section with per-model overrides merged over the built-in table.
- Team results and their `run_end` event carry optional `failures` (`{ name, status, reason, runId }` per member run
  that did not complete) for `parallel`, `chain`, `router`, `evaluator` and `orchestrator`; nested teams are flattened.
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
