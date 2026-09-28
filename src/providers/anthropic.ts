import type { GenerateContext, Message, ModelResponse, Part, Provider, StopReason, Usage } from '../types.ts';
import { ProviderError } from '../util.ts';
import { type FetchLike, postJson, readSse } from './http.ts';

export interface AnthropicOptions {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  version?: string;
  headers?: Record<string, string>;
  stream?: boolean;
  /** Adds prompt-cache breakpoints on system prompt, tool catalog and the latest message. */
  cache?: boolean;
  defaultMaxTokens?: number;
  fetch?: FetchLike;
}

/** Anthropic Messages API adapter (also works with compatible gateways). */
export function anthropic(opts: AnthropicOptions = {}): Provider {
  const baseUrl = (opts.baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, '');
  const fetchImpl = opts.fetch ?? fetch;
  return {
    name: opts.name ?? 'anthropic',
    async generate(req, ctx) {
      const stream = opts.stream ?? false;
      const cache = opts.cache ?? false;
      const p = req.params ?? {};
      const messages = toAnthropicMessages(req.messages);
      if (cache) markLastBlock(messages);
      const tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema }));
      if (cache && tools.length) Object.assign(tools.at(-1)!, { cache_control: { type: 'ephemeral' } });
      const body: Record<string, unknown> = {
        model: req.model,
        max_tokens: p.maxTokens ?? opts.defaultMaxTokens ?? 4096,
        messages,
        ...(req.instructions && {
          system: cache ? [{ type: 'text', text: req.instructions, cache_control: { type: 'ephemeral' } }] : req.instructions,
        }),
        ...(tools.length && { tools }),
        ...(p.temperature !== undefined && { temperature: p.temperature }),
        ...(p.topP !== undefined && { top_p: p.topP }),
        ...(p.stop && { stop_sequences: p.stop }),
        ...(stream && { stream: true }),
        ...p.extra,
      };
      const headers = {
        'anthropic-version': opts.version ?? '2023-06-01',
        ...(opts.apiKey && { 'x-api-key': opts.apiKey }),
        ...opts.headers,
      };
      const res = await postJson(fetchImpl, `${baseUrl}/v1/messages`, headers, body, ctx.signal);
      return stream ? readStream(res, ctx) : fromMessage(await res.json());
    },
  };
}

type Block = Record<string, unknown>;
interface AMessage { role: 'user' | 'assistant'; content: Block[] }

/** Maps neutral messages; tool results become user turns and consecutive same-role turns are merged. */
export function toAnthropicMessages(messages: Message[]): AMessage[] {
  const out: AMessage[] = [];
  for (const m of messages) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const content: Block[] = [];
    for (const p of m.parts) {
      if (p.type === 'text' && p.text) content.push({ type: 'text', text: p.text });
      else if (p.type === 'tool_call') {
        const input = p.args && typeof p.args === 'object' && !Array.isArray(p.args) ? p.args : { _raw: p.args };
        content.push({ type: 'tool_use', id: p.id, name: p.name, input });
      } else if (p.type === 'tool_result') {
        content.push({ type: 'tool_result', tool_use_id: p.callId, content: p.content, ...(p.isError && { is_error: true }) });
      }
    }
    if (!content.length) continue;
    const prev = out.at(-1);
    if (prev && prev.role === role) prev.content.push(...content);
    else out.push({ role, content });
  }
  return out;
}

function markLastBlock(messages: AMessage[]): void {
  const block = messages.at(-1)?.content.at(-1);
  if (block) block.cache_control = { type: 'ephemeral' };
}

const STOP: Record<string, StopReason> = { end_turn: 'end', stop_sequence: 'end', tool_use: 'tool_calls', max_tokens: 'max_tokens' };

function toUsage(u: any): Usage {
  const read = u?.cache_read_input_tokens ?? 0;
  const write = u?.cache_creation_input_tokens ?? 0;
  return {
    inputTokens: (u?.input_tokens ?? 0) + read + write,
    outputTokens: u?.output_tokens ?? 0,
    ...(read && { cacheReadTokens: read }),
    ...(write && { cacheWriteTokens: write }),
  };
}

function toParts(blocks: any[]): Part[] {
  const parts: Part[] = [];
  for (const b of blocks ?? []) {
    if (b.type === 'text' && b.text) parts.push({ type: 'text', text: b.text });
    else if (b.type === 'tool_use') parts.push({ type: 'tool_call', id: b.id, name: b.name, args: b.input ?? {} });
  }
  return parts;
}

export function fromMessage(json: any): ModelResponse {
  if (!Array.isArray(json?.content)) throw new ProviderError(502, `unexpected response: ${JSON.stringify(json).slice(0, 300)}`);
  return { message: { role: 'assistant', parts: toParts(json.content) }, usage: toUsage(json.usage), stopReason: STOP[json.stop_reason] ?? 'other', model: json.model };
}

async function readStream(res: Response, ctx: GenerateContext): Promise<ModelResponse> {
  const blocks: any[] = [];
  const json: Record<number, string> = {};
  let usage: any = {};
  let stop: string | undefined;
  let model: string | undefined;
  for await (const ev of readSse(res)) {
    const data = JSON.parse(ev.data);
    switch (data.type) {
      case 'message_start':
        model = data.message?.model;
        usage = { ...data.message?.usage };
        break;
      case 'content_block_start':
        blocks[data.index] = { ...data.content_block };
        if (data.content_block?.type === 'tool_use') json[data.index] = '';
        break;
      case 'content_block_delta':
        if (data.delta?.type === 'text_delta') {
          blocks[data.index].text = (blocks[data.index].text ?? '') + data.delta.text;
          ctx.onText?.(data.delta.text);
        } else if (data.delta?.type === 'input_json_delta') json[data.index] += data.delta.partial_json;
        break;
      case 'message_delta':
        stop = data.delta?.stop_reason ?? stop;
        usage = { ...usage, ...data.usage };
        break;
      case 'error':
        throw new ProviderError(data.error?.type === 'overloaded_error' ? 529 : 500, `stream error: ${data.error?.message ?? ev.data}`);
    }
  }
  for (const [i, raw] of Object.entries(json)) blocks[Number(i)].input = raw ? JSON.parse(raw) : {};
  return { message: { role: 'assistant', parts: toParts(blocks.filter(Boolean)) }, usage: toUsage(usage), stopReason: STOP[stop ?? ''] ?? 'other', model };
}
