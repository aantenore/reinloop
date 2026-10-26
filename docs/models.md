# Models it has been run against

Results from real runs, with dates. "Contract tests" means the wire format is covered by unit tests with recorded
request/response shapes, but no live call was made. Please add a row when you run it against something new.

## Local model matrix

`npm run live:models` on 2026-09-28/29: Ollama on Apple Silicon, reinloop 0.1, streaming, native JSON-schema output,
8-minute limit per run. Passing cells ran once. Failing cells were re-run twice more, and the table shows successes
out of attempts, so one-off failures can be told apart from real limits.

| Scenario | What passes |
|---|---|
| tools | finds a codename by using `find_files` / `read_file` in a small workspace |
| structured | returns `{ "answer": 51 }` for 17 × 3, schema-validated |
| rag | answers from this project's docs indexed in Chroma through its MCP server (`chroma_query_documents`) |
| team | evaluator pattern (writer + critic) ends approved or at maxRounds with an answer |
| create | the architect writes files that validate **and** include the requested team |

| Model | tools | structured | rag | team | create |
|---|---|---|---|---|---|
| gemma4:12b | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 |
| gemma4-quick:12b | 1/1 | 1/1 | 1/1 | 2/3 (once malformed critic JSON) | 1/1 |
| ornith:9b | 1/1 | 1/1 | 1/1 | 1/1 | 0/3: valid files, no team |
| qwen3.5:9b | 1/1 | 1/1 | 1/1 | 1/1 | 0/3: no team, or a team pointing to a missing agent |
| lfm2.5:8b | 0/3: tool calls as text or no search | 1/1 | 1/1 | 1/1 | 0/3: valid files, no team |
| qwen3:4b | 2/3 (once guessed instead of reading) | 1/1 | 0/3: searches but misses the answer | 1/1 | 0/3: valid files, no team |

**Recommendation for local use:** `gemma4:12b` passed everything. For single agents with tools, RAG and structured
output, the 9-12B models work except lfm2.5 (tool calling). `create` only succeeded with the 12B models.

## Other providers

| Model | Provider path | What was exercised | Result |
|---|---|---|---|
| deterministic mock | `mock/echo`, scripted `mockProvider` | the whole test suite on every CI run | passing on Node 22 and 24 |
| qwen3.5:9b through LiteLLM | `litellm/ollama_chat/qwen3.5:9b` | tool-using agent through the LiteLLM proxy | works |
| OpenAI (GPT-5 family) | `openai/...` | contract tests only (Chat Completions, streaming, tool calls, `max_completion_tokens`, `response_format`) | not run live |
| Anthropic (Claude family) | `anthropic/...` | contract tests only (Messages API, streaming, tool use, cache breakpoints, hosted tools, `output_config.format`) | not run live |
| Gemini, OpenRouter, Groq, Mistral, DeepSeek, xAI, Together, LM Studio, vLLM | presets over the OpenAI-compatible adapter | none beyond the shared adapter's tests | not run live |

## Findings from real runs

Running against local models found five problems that the mocked tests could not. All five are fixed and
now covered by tests:

1. **Truncated streams.** A connection that dropped mid-stream (Ollama loading a model) produced an empty
   "successful" answer. Streams that end without `finish_reason` / `[DONE]` (or `message_stop`) are now a retryable
   error.
2. **Empty turns.** Reasoning models sometimes think and then end the turn with no text and no tool call. Such turns
   now stay out of the history and are retried, and the run fails after three in a row. Two cases are not retried,
   because the identical request would end the same way: a `max_tokens` stop with no text or tool call (typically the
   whole limit spent on thinking) ends the run as `stopped` with reason `max_tokens`, and an empty `refusal` ends it
   as `failed` with reason `refusal`. A truncated answer that fails the output schema also stops with `max_tokens`
   instead of getting a feedback retry.
3. **Invalid JSON from small models.** Answers had `\'` escapes, prose around the JSON, or the JSON wrapped in a copy
   of the schema. The harness now asks for native schema-constrained output, parses tolerantly, and accepts
   schema-wrapped values.
4. **Architect output.** Generated files used an invalid output schema (`text: "string"`), contradicted the pattern's
   JSON contract, and pinned a model without a key. There is now a schema shape check, explicit pattern contracts in
   the architect prompt, a validation error for missing API keys, and `create` re-validates and sends errors back.
5. **RAG denied by policy.** Chroma's query tools carry no read-only annotation, so they were treated as `exec` and
   denied without an approver. MCP servers now accept `readOnly` globs, and catalogue entries declare their
   read-only tools. RAG then passed on 5 of 6 models.

## Structured output per provider

When an agent has an `output` schema, every model request carries it, with or without tools:

- **OpenAI-compatible:** `response_format: json_schema`. The `ollama`, `lmstudio` and `vllm` presets use
  `structuredOutput: "without-tools"`, because their grammar-constrained decoding leaves no room for tool calls; they
  get the schema only on requests without tools. `structuredOutput: false` never sends it.
- **Anthropic:** `output_config.format: { type: "json_schema", schema }`, merged with `params.effort` and any
  `output_config` from `params.extra`. Objects without `additionalProperties` are sent with `additionalProperties: false`,
  as the API requires. No forced `tool_choice` is used. `structuredOutput: false` disables it.

The answer is still validated against the schema, with feedback retries when it does not match.

## Thinking blocks

Anthropic `thinking` and `redacted_thinking` blocks are kept in the history as `thinking` parts, with their signature
(or redacted data), and sent back unchanged on later requests, so tool use with thinking stays valid across turns. On
models that return them with empty text (the default `display: "omitted"`) they still carry the signature. They are
never part of the run output. Other providers ignore these parts.

## Thinking and effort

`params.thinking` and `params.effort` map to Anthropic's `thinking` (`type`, `budget_tokens`, `display`) and
`output_config.effort`; OpenAI-compatible providers ignore them. On the 5.5 models thinking is on by default and the
default `display` is `omitted`, so blocks arrive with empty text. Settings a model is known to reject fail before the
request (`THINKING_RULES`): Opus 5.5 accepts no `disabled`, `enabled` (budget) or `between_tools`; Sonnet 5.5 no
`disabled` or `enabled`, and `between_tools` only at effort `high` or below; Haiku 5.5 no `enabled` or
`between_tools`, and `disabled` only at effort `high` or below.

Reasoning text is streamed as `thinking_delta` events, separate from `text_delta`, from both the streaming and the
non-streaming path (non-empty text only), so a UI can show or hide it. `jsonlSink` skips both kinds of delta unless
`includeDeltas` is set.

Language of thinking summaries: the Messages API has no setting for it. With `display: "summarized"` (or
`"updates"`) the summaries are written by the model and usually follow the language of the conversation, not an
instruction in the system prompt, so they may not match the answer language. To keep reasoning text out of a UI or
log, use `thinking: { display: "omitted" }` (blocks keep their signature, text stays empty; the 5.5 default) or turn
thinking off with `type: "disabled"` where the model allows it (see the rules above).

Malformed tool arguments: a streamed `tool_use` input that is not valid JSON (seen occasionally on small models)
does not fail the run. Syntax damage (trailing commas, unclosed objects/arrays, a dangling key) is repaired and the
call runs; a value cut off mid-way (a string, number or literal, typically at `max_tokens`) is not completed, and the
call is answered with a tool error asking the model to retry with valid JSON. Both cases emit `tool_args_invalid`
(`repaired: true | false`) and count in `usage.toolArgsInvalid`.

Thinking counts against `maxTokens`. With a low limit (a few hundred tokens) a turn can end with `max_tokens` before
any text; the run then stops with reason `max_tokens` (see above). Raise `maxTokens`, lower `effort`, or set
`params.retryMaxTokens`: after a `max_tokens` stop without tool calls the answer is discarded (`model_response` with
`discarded: true`, still counted in usage and cost) and the request is repeated once with that limit, which is kept
for the rest of the run. It is off by default.

## Practical guidance

- Tool calling and chat work well with 8-9B local models. Multi-agent quality loops and `create` benefit from larger
  or hosted models.
- Reasoning models spend many output tokens thinking. Set `budget.maxTotalTokens` or `maxDurationMs` accordingly.
- For deterministic tests of your own agents, use `mock/echo` or scripted `mockProvider`, plus the exact
  `responseCache` in a `ci` profile.
