import { closedSchema } from '../schema.ts';
import type { Effort, GenerateContext, HostedResultPart, Message, ModelParams, ModelResponse, Part, Provider, StopReason, ThinkingType, ToolSpec, Usage } from '../types.ts';
import { limitDefault } from '../limits.ts';
import { estimateTokens, ProviderError, truncate } from '../util.ts';
import { type Deadline, type FetchLike, parseToolJson, postJson, readSse, requestTimeoutMs, withDeadline } from './http.ts';

export interface AnthropicOptions {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  version?: string;
  headers?: Record<string, string>;
  stream?: boolean;
  /**
   * Prompt-cache breakpoints on tool catalog, system prompt and the latest message (rolling), default on.
   * `params.cache` overrides it per agent.
   */
  cache?: boolean;
  /** Breakpoint lifetime (default `5m`); `params.cacheTtl` overrides it. */
  cacheTtl?: '5m' | '1h';
  /** Breakpoints whose estimated prefix is shorter than this are left out (default 1024 tokens: below the API minimum). */
  cacheMinTokens?: number;
  /** Output tokens when the request sets no `maxTokens` (default 4096). */
  defaultMaxTokens?: number;
  /** Response text kept in an HTTP error (default 500). */
  errorBodyChars?: number;
  /** Response JSON kept when a response has an unexpected shape (default 300). */
  responseExcerptChars?: number;
  /**
   * Time limit of one request in ms (default 600000; Infinity: none). Non-streamed: the whole request, body included.
   * Streamed: time to the first chunk, then the longest silence between two chunks. Expiry rejects with a
   * `TimeoutError` (HTTP 408, so `withRetry` retries it unless `retryOn` leaves 408 out).
   */
  timeoutMs?: number;
  /** Send `output_config.format: json_schema` when a schema is requested (default true; disable for gateways that reject it). */
  structuredOutput?: boolean;
  fetch?: FetchLike;
}

/**
 * Thinking settings each model rejects (the API answers 400). `upToHigh`: accepted only with effort `high` or below
 * (an unset effort counts as the model default, which is below `high`). Matched by substring of the model id.
 */
export const THINKING_RULES: Record<string, { rejects?: ThinkingType[]; upToHigh?: ThinkingType[] }> = {
  'claude-opus-5-5': { rejects: ['disabled', 'enabled', 'between_tools'] },
  'claude-sonnet-5-5': { rejects: ['disabled', 'enabled'], upToHigh: ['between_tools'] },
  'claude-haiku-5-5': { rejects: ['enabled', 'between_tools'], upToHigh: ['disabled'] },
};

const ABOVE_HIGH: ReadonlySet<Effort> = new Set(['xhigh', 'max']);

/** Fails fast, before a paid request, on thinking settings the model is known to reject. */
export function checkThinking(model: string, p: ModelParams): void {
  const type = p.thinking?.type;
  if (!type) return;
  if (type === 'enabled' && p.thinking!.budgetTokens === undefined) throw new ProviderError(400, 'thinking type "enabled" needs budgetTokens');
  for (const [id, rule] of Object.entries(THINKING_RULES)) {
    if (!model.includes(id)) continue;
    if (rule.rejects?.includes(type)) throw new ProviderError(400, `${id} does not accept thinking type "${type}"`);
    if (rule.upToHigh?.includes(type) && p.effort && ABOVE_HIGH.has(p.effort)) {
      throw new ProviderError(400, `${id} accepts thinking type "${type}" only with effort high or below (got "${p.effort}")`);
    }
  }
}

/** Anthropic Messages API adapter (also works with compatible gateways). */
export function anthropic(opts: AnthropicOptions = {}): Provider {
  const baseUrl = (opts.baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, '');
  const fetchImpl = opts.fetch ?? fetch;
  return {
    name: opts.name ?? 'anthropic',
    async generate(req, ctx) {
      const stream = opts.stream ?? false;
      const p = req.params ?? {};
      const cache = p.cache ?? opts.cache ?? true;
      const ttl = p.cacheTtl ?? opts.cacheTtl;
      const mark = { type: 'ephemeral', ...(ttl === '1h' && { ttl: '1h' }) };
      const minTokens = opts.cacheMinTokens ?? DEFAULT_CACHE_MIN_TOKENS;
      checkThinking(req.model, p);
      const messages = toAnthropicMessages(req.messages);
      // Cumulative prefix sizes (render order: tools, system, messages) decide which breakpoints are worth sending.
      const toolsTokens = estimateTokens(req.tools);
      const systemTokens = toolsTokens + estimateTokens(req.instructions ?? '');
      const allTokens = systemTokens + estimateTokens(messages);
      if (cache && allTokens >= minTokens) markLastBlock(messages, mark);
      const tools: Block[] = req.tools.map((t) => (t.hosted ? hostedToolBlock(t) : { name: t.name, description: t.description, input_schema: t.schema }));
      const betas = [...new Set(req.tools.flatMap((t) => (t.hosted?.beta ? [t.hosted.beta] : [])))];
      if (cache && tools.length && toolsTokens >= minTokens) Object.assign(tools.at(-1)!, { cache_control: mark });
      const body: Record<string, unknown> = {
        model: req.model,
        max_tokens: p.maxTokens ?? opts.defaultMaxTokens ?? limitDefault('provider.defaultMaxTokens'),
        messages,
        ...(req.instructions && {
          system: cache && systemTokens >= minTokens ? [{ type: 'text', text: req.instructions, cache_control: mark }] : req.instructions,
        }),
        ...(tools.length && { tools }),
        ...(p.temperature !== undefined && { temperature: p.temperature }),
        ...(p.topP !== undefined && { top_p: p.topP }),
        ...(p.stop && { stop_sequences: p.stop }),
        ...(p.thinking && {
          thinking: {
            type: p.thinking.type,
            ...(p.thinking.budgetTokens !== undefined && { budget_tokens: p.thinking.budgetTokens }),
            ...(p.thinking.display && { display: p.thinking.display }),
          },
        }),
        ...(stream && { stream: true }),
        ...p.extra,
      };
      // Effort and structured output (which works alongside tools) merge into any `output_config` from params.extra.
      const format = req.responseSchema && opts.structuredOutput !== false ? { type: 'json_schema', schema: closedSchema(req.responseSchema) } : undefined;
      if (p.effort || format) {
        body.output_config = { ...(body.output_config as Record<string, unknown> | undefined), ...(p.effort && { effort: p.effort }), ...(format && { format }) };
      }
      const headers = {
        'anthropic-version': opts.version ?? '2023-06-01',
        ...(opts.apiKey && { 'x-api-key': opts.apiKey }),
        ...opts.headers,
      };
      if (betas.length) {
        const current = Object.entries(headers).find(([k]) => k.toLowerCase() === 'anthropic-beta');
        const merged = [...new Set([...(current ? String(current[1]).split(',').map((b) => b.trim()).filter(Boolean) : []), ...betas])];
        if (current) delete (headers as Record<string, string>)[current[0]];
        (headers as Record<string, string>)['anthropic-beta'] = merged.join(',');
      }
      return withDeadline(requestTimeoutMs(opts.timeoutMs), ctx.signal, async (dl) => {
        const res = await postJson(fetchImpl, `${baseUrl}/v1/messages`, headers, body, dl.signal, opts.errorBodyChars);
        if (stream) return readStream(res, ctx, dl);
        const out = fromMessage(await res.json(), opts.responseExcerptChars);
        for (const part of out.message.parts) if (part.type === 'thinking' && part.text) ctx.onThinking?.(part.text);
        return out;
      });
    },
  };
}

type Block = Record<string, unknown>;
interface AMessage { role: 'user' | 'assistant'; content: Block[] }

/** Hosted tools are sent as `{ type, name, ...params }`; tools meant for another provider fail before the request. */
export function hostedToolBlock(t: ToolSpec): Block {
  const h = t.hosted!;
  if (h.provider !== 'anthropic') throw new ProviderError(400, `hosted tool "${t.name}" targets provider "${h.provider}", not anthropic`);
  return { type: h.type, name: t.name, ...h.params };
}

/** Maps neutral messages; tool results become user turns and consecutive same-role turns are merged. */
export function toAnthropicMessages(messages: Message[]): AMessage[] {
  const out: AMessage[] = [];
  for (const m of messages) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const content: Block[] = [];
    for (const p of m.parts) {
      if (p.type === 'text' && p.text) content.push({ type: 'text', text: p.text, ...(p.citations?.length && role === 'assistant' && { citations: p.citations }) });
      else if (p.type === 'hosted_call' && role === 'assistant') content.push({ type: 'server_tool_use', id: p.id, name: p.name, input: p.input ?? {} });
      else if (p.type === 'hosted_result' && role === 'assistant') content.push({ type: p.blockType, tool_use_id: p.callId, content: p.content });
      else if (p.type === 'thinking' && role === 'assistant') {
        // Echoed back unchanged (signature included) so multi-turn tool use with thinking stays valid.
        if (p.redacted !== undefined) content.push({ type: 'redacted_thinking', data: p.redacted });
        else if (p.signature) content.push({ type: 'thinking', thinking: p.text, signature: p.signature });
      } else if (p.type === 'tool_call') {
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

export const DEFAULT_CACHE_MIN_TOKENS = limitDefault('provider.cacheMinTokens');

/** Thinking blocks cannot carry `cache_control`: the rolling breakpoint goes on the last block that can. */
function markLastBlock(messages: AMessage[], mark: Block): void {
  const blocks = messages.at(-1)?.content ?? [];
  const block = [...blocks].reverse().find((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking');
  if (block) block.cache_control = mark;
}

const STOP: Record<string, StopReason> = {
  end_turn: 'end', stop_sequence: 'end', tool_use: 'tool_calls', max_tokens: 'max_tokens', refusal: 'refusal', pause_turn: 'pause_turn',
};

const camel = (k: string) => k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

function toUsage(u: any): Usage {
  const read = u?.cache_read_input_tokens ?? 0;
  const write = u?.cache_creation_input_tokens ?? 0;
  const write1h = u?.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  return {
    inputTokens: (u?.input_tokens ?? 0) + read + write,
    outputTokens: u?.output_tokens ?? 0,
    ...(read && { cacheReadTokens: read }),
    ...(write && { cacheWriteTokens: write }),
    ...(write1h && { cacheWrite1hTokens: write1h }),
    ...serverToolUse(u?.server_tool_use),
  };
}

/** `server_tool_use: { web_search_requests: 2 }` -> `{ serverToolUse: { webSearchRequests: 2 } }` (non-zero counts only). */
function serverToolUse(raw: unknown): Pick<Usage, 'serverToolUse'> {
  if (!raw || typeof raw !== 'object') return {};
  const counts: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) if (typeof v === 'number' && v > 0) counts[camel(k)] = v;
  return Object.keys(counts).length ? { serverToolUse: counts } : {};
}

/** Provider-neutral digest of a hosted tool result block: error flag, short summary, cited sources. */
export function digestHostedResult(blockType: string, content: any): Pick<HostedResultPart, 'isError' | 'summary' | 'sources'> {
  if (Array.isArray(content)) {
    const sources = content.filter((r) => typeof r?.url === 'string').map((r) => ({ url: r.url as string, ...(r.title && { title: String(r.title) }) }));
    const list = sources.slice(0, 5).map((s) => (s.title ? `${s.title} <${s.url}>` : s.url)).join('; ');
    return { isError: false, summary: truncate(`${sources.length} result(s)${list ? `: ${list}` : ''}`, 500), ...(sources.length && { sources }) };
  }
  if (content && typeof content === 'object') {
    if (content.error_code || /_error$/.test(String(content.type ?? ''))) return { isError: true, summary: `error: ${content.error_code ?? content.type}` };
    if (typeof content.url === 'string') {
      const title = content.content?.title ?? content.title;
      return { isError: false, summary: truncate(`fetched ${content.url}${title ? ` (${title})` : ''}`, 500), sources: [{ url: content.url, ...(title && { title: String(title) }) }] };
    }
    if ('return_code' in content || 'stdout' in content) {
      const out = String(content.stdout || content.stderr || '').trim();
      return { isError: false, summary: truncate(`exit ${content.return_code ?? '?'}${out ? `: ${out}` : ''}`, 500) };
    }
    return { isError: false, summary: String(content.type ?? blockType) };
  }
  return { isError: false, summary: blockType };
}

function toParts(blocks: any[]): Part[] {
  const parts: Part[] = [];
  const hostedNames = new Map<string, string>();
  for (const b of blocks ?? []) {
    if (b.type === 'text' && b.text) parts.push({ type: 'text', text: b.text, ...(Array.isArray(b.citations) && b.citations.length && { citations: b.citations }) });
    else if (b.type === 'server_tool_use') {
      hostedNames.set(b.id, b.name);
      parts.push({ type: 'hosted_call', id: b.id, name: b.name, input: b.input ?? {} });
    } else if (typeof b.type === 'string' && b.type.endsWith('_tool_result') && b.tool_use_id) {
      const name = hostedNames.get(b.tool_use_id) ?? b.type.replace(/_tool_result$/, '');
      parts.push({ type: 'hosted_result', callId: b.tool_use_id, name, blockType: b.type, content: b.content, ...digestHostedResult(b.type, b.content) });
    }
    else if (b.type === 'thinking') parts.push({ type: 'thinking', text: b.thinking ?? '', ...(b.signature && { signature: b.signature }) });
    else if (b.type === 'redacted_thinking') parts.push({ type: 'thinking', text: '', redacted: b.data ?? '' });
    else if (b.type === 'tool_use') parts.push({ type: 'tool_call', id: b.id, name: b.name, args: b.input ?? {}, ...(b.argsIssue && { argsIssue: b.argsIssue }) });
  }
  return parts;
}

export function fromMessage(json: any, excerptChars: number = limitDefault('provider.responseExcerptChars')): ModelResponse {
  if (!Array.isArray(json?.content)) throw new ProviderError(502, `unexpected response: ${JSON.stringify(json).slice(0, excerptChars)}`);
  return { message: { role: 'assistant', parts: toParts(json.content) }, usage: toUsage(json.usage), stopReason: STOP[json.stop_reason] ?? 'other', model: json.model };
}

async function readStream(res: Response, ctx: GenerateContext, dl: Deadline): Promise<ModelResponse> {
  const blocks: any[] = [];
  const json: Record<number, string> = {};
  let usage: any = {};
  let stop: string | undefined;
  let model: string | undefined;
  let complete = false;
  for await (const ev of readSse(res, dl.touch)) {
    const data = JSON.parse(ev.data);
    switch (data.type) {
      case 'message_stop':
        complete = true;
        break;
      case 'message_start':
        model = data.message?.model;
        usage = { ...data.message?.usage };
        break;
      case 'content_block_start':
        blocks[data.index] = { ...data.content_block };
        if (data.content_block?.type === 'tool_use' || data.content_block?.type === 'server_tool_use') json[data.index] = '';
        break;
      case 'content_block_delta':
        if (data.delta?.type === 'text_delta') {
          blocks[data.index].text = (blocks[data.index].text ?? '') + data.delta.text;
          ctx.onText?.(data.delta.text);
        } else if (data.delta?.type === 'thinking_delta') {
          blocks[data.index].thinking = (blocks[data.index].thinking ?? '') + data.delta.thinking;
          if (data.delta.thinking) ctx.onThinking?.(data.delta.thinking);
        } else if (data.delta?.type === 'signature_delta') {
          blocks[data.index].signature = (blocks[data.index].signature ?? '') + data.delta.signature;
        } else if (data.delta?.type === 'citations_delta') {
          blocks[data.index].citations = [...(blocks[data.index].citations ?? []), data.delta.citation];
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
  if (!complete) throw new ProviderError(502, 'stream ended before completion');
  let invalidArgs = 0;
  for (const [i, raw] of Object.entries(json)) {
    const block = blocks[Number(i)];
    if (!raw) {
      block.input ??= {};
      continue;
    }
    const parsed = parseToolJson(raw);
    const objectValue = 'value' in parsed && parsed.value !== null && typeof parsed.value === 'object' && !Array.isArray(parsed.value);
    if ('value' in parsed && objectValue && !parsed.repaired) {
      block.input = parsed.value;
      continue;
    }
    if (block.type === 'server_tool_use') {
      // Hosted calls already ran on the provider side; keep what can be kept.
      block.input = objectValue ? (parsed as { value: unknown }).value : {};
      continue;
    }
    invalidArgs++;
    if (objectValue) {
      block.input = (parsed as { value: unknown }).value;
      block.argsIssue = { error: (parsed as { repaired: string }).repaired, repaired: true };
    } else {
      block.input = {};
      block.argsIssue = { error: 'error' in parsed ? parsed.error : 'arguments must be a JSON object', repaired: false };
    }
  }
  const u = toUsage(usage);
  if (invalidArgs) u.toolArgsInvalid = invalidArgs;
  return { message: { role: 'assistant', parts: toParts(blocks.filter(Boolean)) }, usage: u, stopReason: STOP[stop ?? ''] ?? 'other', model };
}
