# LLM providers

The model layer. reinloop talks to models through a `Provider`:

```ts
interface Provider { name: string; generate(req: ModelRequest, ctx: { signal; onText?; onThinking? }): Promise<ModelResponse> }
```

## Built in

| Standard | Provider |
|---|---|
| OpenAI Chat Completions (de facto) | `openaiCompatible`: OpenAI, Ollama, vLLM, LM Studio, OpenRouter, Groq, LiteLLM and any gateway behind such a URL |
| Anthropic Messages | `anthropic` |
| none | `mockProvider`, for tests |

OpenAI-compatible and Anthropic are also presets (`"<preset>/<model>"`, see [models](../models.md)). A server that
speaks one of these protocols needs no code: point a preset or a `providers` entry at its URL. `withRetry` and
`withFallback` wrap any provider.

## Extension point

Anything else implements `Provider` and registers a factory (`registry.providers.set(name, factory)`, usually from a
plugin) or is passed directly as `model.provider`.

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

`checkOpenAIEndpoint({ baseUrl, apiKey?, model, params?, headers?, fetch? })` runs the same check against a raw
OpenAI-compatible Chat Completions URL, with its own minimal client, so any gateway or model server can be certified.
Both call the model twice, so they cost real tokens on a hosted provider.
