import type { GenerateContext, ModelRequest, ModelResponse, Part, Provider, StopReason, Usage } from '../types.ts';
import { ProviderError, textOf } from '../util.ts';
import { type FetchLike, parseArgs, postJson, readSse } from './http.ts';

export interface OpenAICompatibleOptions {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  stream?: boolean;
  /** Newer OpenAI models require `max_completion_tokens`; most compatible servers accept `max_tokens`. */
  maxTokensParam?: 'max_tokens' | 'max_completion_tokens';
  /** Send `response_format: json_schema` when a schema is requested (default true; disable for servers that reject it). */
  structuredOutput?: boolean;
  fetch?: FetchLike;
}

/** Chat Completions adapter: OpenAI, Azure-compatible gateways, Ollama, vLLM, LM Studio, OpenRouter, Groq, ... */
export function openaiCompatible(opts: OpenAICompatibleOptions = {}): Provider {
  const baseUrl = (opts.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  const fetchImpl = opts.fetch ?? fetch;
  return {
    name: opts.name ?? 'openai-compatible',
    async generate(req, ctx) {
      const stream = opts.stream ?? false;
      const p = req.params ?? {};
      const body: Record<string, unknown> = {
        model: req.model,
        messages: toOpenAIMessages(req),
        ...(req.tools.length && {
          tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } })),
        }),
        ...(p.temperature !== undefined && { temperature: p.temperature }),
        ...(p.topP !== undefined && { top_p: p.topP }),
        ...(p.stop && { stop: p.stop }),
        ...(p.maxTokens !== undefined && { [opts.maxTokensParam ?? 'max_tokens']: p.maxTokens }),
        ...(req.responseSchema && opts.structuredOutput !== false && {
          response_format: { type: 'json_schema', json_schema: { name: 'output', schema: req.responseSchema, strict: false } },
        }),
        ...(stream && { stream: true, stream_options: { include_usage: true } }),
        ...p.extra,
      };
      const headers = { ...(opts.apiKey && { authorization: `Bearer ${opts.apiKey}` }), ...opts.headers };
      const res = await postJson(fetchImpl, `${baseUrl}/chat/completions`, headers, body, ctx.signal);
      return stream ? readStream(res, ctx) : fromCompletion(await res.json());
    },
  };
}

export function toOpenAIMessages(req: ModelRequest): unknown[] {
  const out: unknown[] = [];
  if (req.instructions) out.push({ role: 'system', content: req.instructions });
  for (const m of req.messages) {
    if (m.role === 'user') out.push({ role: 'user', content: textOf(m) });
    else if (m.role === 'assistant') {
      const calls = m.parts.filter((p) => p.type === 'tool_call');
      out.push({
        role: 'assistant',
        content: textOf(m) || (calls.length ? null : ''),
        ...(calls.length && {
          tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } })),
        }),
      });
    } else {
      for (const p of m.parts) if (p.type === 'tool_result') out.push({ role: 'tool', tool_call_id: p.callId, content: p.content });
    }
  }
  return out;
}

const STOP: Record<string, StopReason> = { stop: 'end', tool_calls: 'tool_calls', function_call: 'tool_calls', length: 'max_tokens' };

function toUsage(u: any): Usage {
  return {
    inputTokens: u?.prompt_tokens ?? 0,
    outputTokens: u?.completion_tokens ?? 0,
    ...(u?.prompt_tokens_details?.cached_tokens && { cacheReadTokens: u.prompt_tokens_details.cached_tokens }),
  };
}

export function fromCompletion(json: any): ModelResponse {
  const choice = json?.choices?.[0];
  if (!choice) throw new ProviderError(502, `no choices in response: ${JSON.stringify(json).slice(0, 300)}`);
  const msg = choice.message ?? {};
  const parts: Part[] = [];
  if (typeof msg.content === 'string' && msg.content) parts.push({ type: 'text', text: msg.content });
  for (const tc of msg.tool_calls ?? []) {
    parts.push({ type: 'tool_call', id: tc.id ?? '', name: tc.function?.name ?? '', args: parseArgs(tc.function?.arguments) });
  }
  const hasCalls = parts.some((p) => p.type === 'tool_call');
  return {
    message: { role: 'assistant', parts },
    usage: toUsage(json.usage),
    stopReason: hasCalls ? 'tool_calls' : (STOP[choice.finish_reason] ?? 'other'),
    model: json.model,
  };
}

async function readStream(res: Response, ctx: GenerateContext): Promise<ModelResponse> {
  let text = '';
  let finish: string | undefined;
  let usage: any;
  let model: string | undefined;
  const calls: Array<{ id: string; name: string; args: string }> = [];
  let complete = false;
  for await (const ev of readSse(res)) {
    if (ev.data === '[DONE]') {
      complete = true;
      break;
    }
    const chunk = JSON.parse(ev.data);
    if (chunk.error) throw new ProviderError(500, `stream error: ${chunk.error.message ?? JSON.stringify(chunk.error)}`);
    model ??= chunk.model;
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? {};
    if (delta.content) {
      text += delta.content;
      ctx.onText?.(delta.content);
    }
    for (const tc of delta.tool_calls ?? []) {
      const slot = (calls[tc.index ?? calls.length] ??= { id: '', name: '', args: '' });
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.name += tc.function.name;
      if (tc.function?.arguments) slot.args += tc.function.arguments;
    }
    if (choice.finish_reason) (finish = choice.finish_reason), (complete = true);
  }
  // A dropped connection must not look like an empty successful answer (retryable 502).
  if (!complete) throw new ProviderError(502, 'stream ended before completion');
  const parts: Part[] = text ? [{ type: 'text', text }] : [];
  for (const c of calls.filter(Boolean)) parts.push({ type: 'tool_call', id: c.id, name: c.name, args: parseArgs(c.args) });
  const hasCalls = calls.length > 0;
  return { message: { role: 'assistant', parts }, usage: toUsage(usage), stopReason: hasCalls ? 'tool_calls' : (STOP[finish ?? ''] ?? 'other'), model };
}
