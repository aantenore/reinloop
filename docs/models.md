# Models it has been run against

Results from real runs, with dates. "Contract tests" means the wire format is covered by unit tests with recorded
request/response shapes, but no live call was made. Please add a row when you run it against something new.

## Local model matrix

`npm run live:models` on 2026-09-28: Ollama on Apple Silicon, reinloop 0.1, streaming, native JSON-schema output.
Each cell is one run of the scenario (no retries beyond the harness's own), with a time limit of 8 minutes.

| Scenario | What passes |
|---|---|
| tools | finds a codename by using `find_files` / `read_file` in a small workspace |
| structured | returns `{ "answer": 51 }` for 17 × 3, schema-validated |
| rag | answers from this project's docs indexed in Chroma through its MCP server (`chroma_query_documents`) |
| team | evaluator pattern (writer + critic) ends approved or at maxRounds with an answer |
| create | the architect writes files that validate **and** include the requested team |

| Model | tools | structured | rag | team | create |
|---|---|---|---|---|---|
| gemma4:12b | yes | yes | yes | yes | yes |
| gemma4-quick:12b | yes | yes | yes | no: critic emitted malformed JSON | yes |
| ornith:9b | yes | yes | yes | yes | no: valid files, no team |
| lfm2.5:8b | no: tool calls written as text | yes | yes | yes | no: valid files, no team |
| qwen3.5:9b | yes | yes | yes | yes (approved in round 2) | no: valid files, no team |
| qwen3:4b | no: guessed instead of reading | yes | no: answered without searching | yes | no: valid files, no team |

**Recommendation for local use:** `gemma4:12b` passed everything. For single agents with tools, RAG and structured
output, any of the 9-12B models above works. Use a 12B+ model for `create`.

## Other providers

| Model | Provider path | What was exercised | Result |
|---|---|---|---|
| deterministic mock | `mock/echo`, scripted `mockProvider` | the whole test suite on every CI run | passing on Node 22 and 24 |
| qwen3.5:9b through LiteLLM | `litellm/ollama_chat/qwen3.5:9b` | tool-using agent through the LiteLLM proxy | works |
| OpenAI (GPT-5 family) | `openai/...` | contract tests only (Chat Completions, streaming, tool calls, `max_completion_tokens`, `response_format`) | not run live |
| Anthropic (Claude family) | `anthropic/...` | contract tests only (Messages API, streaming, tool use, cache breakpoints) | not run live |
| Gemini, OpenRouter, Groq, Mistral, DeepSeek, xAI, Together, LM Studio, vLLM | presets over the OpenAI-compatible adapter | none beyond the shared adapter's tests | not run live |

## Findings from real runs

Running against local models found five problems that the mocked tests could not. All five are fixed and
now covered by tests:

1. **Truncated streams.** A connection that dropped mid-stream (Ollama loading a model) produced an empty
   "successful" answer. Streams that end without `finish_reason` / `[DONE]` (or `message_stop`) are now a retryable
   error.
2. **Empty turns.** Reasoning models sometimes think and then end the turn with no text and no tool call. Such turns
   now stay out of the history and are retried, and the run fails after three in a row.
3. **Invalid JSON from small models.** Answers had `\'` escapes, prose around the JSON, or the JSON wrapped in a copy
   of the schema. The harness now asks for native schema-constrained output (`response_format: json_schema`) when
   the agent has no tools or is only fixing its answer, parses tolerantly, and accepts schema-wrapped values.
4. **Architect output.** Generated files used an invalid output schema (`text: "string"`), contradicted the pattern's
   JSON contract, and pinned a model without a key. There is now a schema shape check, explicit pattern contracts in
   the architect prompt, a validation error for missing API keys, and `create` re-validates and sends errors back.
5. **RAG denied by policy.** Chroma's query tools carry no read-only annotation, so they were treated as `exec` and
   denied without an approver. MCP servers now accept `readOnly` globs, and catalogue entries declare their
   read-only tools. RAG then passed on 5 of 6 models.

## Practical guidance

- Tool calling and chat work well with 8-9B local models. Multi-agent quality loops and `create` benefit from larger
  or hosted models.
- Reasoning models spend many output tokens thinking. Set `budget.maxTotalTokens` or `maxDurationMs` accordingly.
- For deterministic tests of your own agents, use `mock/echo` or scripted `mockProvider`, plus the exact
  `responseCache` in a `ci` profile.
