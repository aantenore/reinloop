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
