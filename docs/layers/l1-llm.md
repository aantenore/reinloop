# L1 LLM

The model layer. reinloop talks to models through a `Provider`:

```ts
interface Provider { name: string; generate(req: ModelRequest, ctx: { signal; onText?; onThinking? }): Promise<ModelResponse> }
```

## Standards

| Standard | Provider |
|---|---|
| OpenAI Chat Completions (de facto) | `openaiCompatible`: OpenAI, Ollama, vLLM, LM Studio, OpenRouter, Groq, LiteLLM and any gateway behind such a URL |
| Anthropic Messages | `anthropic` |

Both are available as presets (`"<preset>/<model>"`, see [models](../models.md)). A server that speaks one of these
protocols needs no code: point a preset or a `providers` entry at its URL.

## Extension point

Anything else implements `Provider` and registers a factory (`registry.providers.set(name, factory)`, usually from a
plugin) or is passed directly as `model.provider`.

## Reference implementation

Ollama (MIT), through the `ollama` preset (`OLLAMA_BASE_URL`, default `http://localhost:11434/v1`).

## Conformance

`checkProvider(provider, { model, signal?, params? })` returns the list of failures (empty means conformant). It runs
two turns:

1. A plain text turn: non-empty text, no tool calls, `stopReason` `end`, usage with integer, non-zero token counts,
   streamed `onText` deltas that add up to the final text.
2. A forced tool-call turn: a call to the offered tool, with an id, valid JSON arguments that satisfy the tool's schema,
   and `stopReason` `tool_calls`.

```ts
import { checkProvider, resolveModel } from 'reinloop';

const { provider, model } = resolveModel('ollama/qwen3:4b');
const failures = await checkProvider(provider, { model, params: { maxTokens: 512 } });
if (failures.length) throw new Error(failures.join('\n'));
```

It calls the model twice, so it costs real tokens on a hosted provider.
