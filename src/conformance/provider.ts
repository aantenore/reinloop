// Self-contained on purpose (contract types and Node built-ins only), so the check can be copied or run on its own.
import type { Message, ModelParams, ModelRequest, ModelResponse, Provider, StopReason, ToolCallPart } from '../types.ts';

export interface ProviderCheckOptions {
  /** Model id sent to the provider. */
  model: string;
  signal?: AbortSignal;
  /** Sampling settings for every turn (e.g. `maxTokens` for models that reason before answering). */
  params?: ModelParams;
}

const STOP_REASONS: StopReason[] = ['end', 'tool_calls', 'max_tokens', 'refusal', 'pause_turn', 'other'];
const TOOL = {
  name: 'record_number',
  description: 'Record a number.',
  schema: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'], additionalProperties: false },
};

const textOf = (m: Message): string => m.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('');
const callsOf = (m: Message): ToolCallPart[] => m.parts.filter((p): p is ToolCallPart => p.type === 'tool_call');
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The arguments of the check's own tool: an object with an integer `n` and nothing else. */
function argsProblem(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return 'arguments are not a JSON object';
  const keys = Object.keys(args);
  if (!('n' in args) || !Number.isInteger((args as { n: unknown }).n)) return 'argument "n" must be an integer';
  return keys.length > 1 ? `unexpected arguments: ${keys.filter((k) => k !== 'n').join(', ')}` : undefined;
}

/**
 * Conformance check for a `Provider`: a plain text turn, a forced tool-call turn with valid JSON arguments,
 * usage reporting and sane stop reasons. Returns the list of failures; empty means conformant.
 */
export async function checkProvider(provider: Provider, opts: ProviderCheckOptions): Promise<string[]> {
  const failures: string[] = [];
  const signal = opts.signal ?? new AbortController().signal;

  const turn = async (label: string, req: Omit<ModelRequest, 'model' | 'params'>): Promise<{ res: ModelResponse; streamed: string } | undefined> => {
    let streamed = '';
    try {
      const res = await provider.generate({ ...req, model: opts.model, params: opts.params }, { signal, onText: (d) => (streamed += d) });
      return { res, streamed };
    } catch (err) {
      failures.push(`${label}: generate() threw: ${message(err)}`);
      return undefined;
    }
  };

  /** Checks shared by every turn; false when the message is unusable. */
  const common = (label: string, res: ModelResponse, streamed: string): boolean => {
    if (res.message?.role !== 'assistant' || !Array.isArray(res.message.parts)) {
      failures.push(`${label}: message must be an assistant message with parts`);
      return false;
    }
    if (!STOP_REASONS.includes(res.stopReason)) failures.push(`${label}: unknown stopReason "${res.stopReason}"`);
    const { inputTokens, outputTokens } = res.usage ?? ({} as Partial<ModelResponse['usage']>);
    if (![inputTokens, outputTokens].every((n) => Number.isInteger(n) && n! >= 0)) failures.push(`${label}: usage must report integer inputTokens and outputTokens >= 0`);
    else if (inputTokens === 0 && outputTokens === 0) failures.push(`${label}: usage reports zero tokens`);
    if (streamed && streamed !== textOf(res.message)) failures.push(`${label}: onText deltas do not add up to the message text`);
    return true;
  };

  const user = (text: string): Message => ({ role: 'user', parts: [{ type: 'text', text }] });

  const plain = await turn('text turn', { messages: [user('Reply with the single word: pong')], tools: [] });
  if (plain && common('text turn', plain.res, plain.streamed)) {
    const { res } = plain;
    if (!textOf(res.message).trim()) failures.push('text turn: empty answer text');
    if (callsOf(res.message).length) failures.push('text turn: tool calls returned although no tools were offered');
    if (res.stopReason !== 'end' && res.stopReason !== 'max_tokens') failures.push(`text turn: expected stopReason "end", got "${res.stopReason}"`);
  }

  const forced = await turn('tool turn', {
    instructions: 'You must call the record_number tool with n=42. Do not answer in text.',
    messages: [user('Record the number 42.')],
    tools: [TOOL],
  });
  if (forced && common('tool turn', forced.res, forced.streamed)) {
    const calls = callsOf(forced.res.message);
    const call = calls.find((c) => c.name === TOOL.name);
    if (!call) failures.push(`tool turn: expected a call to "${TOOL.name}", got ${calls.length ? calls.map((c) => c.name).join(', ') : 'none'}`);
    else {
      if (!call.id) failures.push('tool turn: tool call has no id');
      if (call.argsIssue) failures.push(`tool turn: arguments were not valid JSON (${call.argsIssue.error})`);
      else {
        const problem = argsProblem(call.args);
        if (problem) failures.push(`tool turn: arguments do not match the schema: ${problem}`);
      }
      if (forced.res.stopReason !== 'tool_calls') failures.push(`tool turn: expected stopReason "tool_calls", got "${forced.res.stopReason}"`);
    }
  }

  return failures;
}

export interface EndpointCheckOptions extends ProviderCheckOptions {
  /** Base URL of an OpenAI-compatible API, e.g. `http://localhost:11434/v1`. */
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

const FINISH: Record<string, StopReason> = { stop: 'end', tool_calls: 'tool_calls', function_call: 'tool_calls', length: 'max_tokens', content_filter: 'refusal' };

/**
 * Runs `checkProvider` against a raw OpenAI-compatible Chat Completions endpoint (no reinloop provider needed), so any
 * gateway or model server can be certified. Uses its own minimal non-streaming client.
 */
export function checkOpenAIEndpoint(opts: EndpointCheckOptions): Promise<string[]> {
  const url = `${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const fetchImpl = opts.fetch ?? fetch;
  const provider: Provider = {
    name: 'openai-endpoint',
    async generate(req, ctx) {
      const messages: unknown[] = [];
      if (req.instructions) messages.push({ role: 'system', content: req.instructions });
      for (const m of req.messages) messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: textOf(m) });
      const p = req.params ?? {};
      const body = {
        model: req.model,
        messages,
        ...(req.tools.length && { tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } })) }),
        ...(p.temperature !== undefined && { temperature: p.temperature }),
        ...(p.maxTokens !== undefined && { max_tokens: p.maxTokens }),
      };
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(opts.apiKey && { authorization: `Bearer ${opts.apiKey}` }), ...opts.headers },
        body: JSON.stringify(body),
        signal: ctx.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const json = (await res.json()) as any;
      const choice = json.choices?.[0];
      if (!choice?.message) throw new Error('response has no choices[0].message');
      const parts: Message['parts'] = [];
      if (typeof choice.message.content === 'string' && choice.message.content) parts.push({ type: 'text', text: choice.message.content });
      for (const c of choice.message.tool_calls ?? []) {
        let args: unknown = {};
        let argsIssue: ToolCallPart['argsIssue'];
        try {
          args = JSON.parse(c.function?.arguments || '{}');
        } catch (err) {
          argsIssue = { error: message(err), repaired: false };
        }
        parts.push({ type: 'tool_call', id: c.id ?? '', name: c.function?.name ?? '', args, ...(argsIssue && { argsIssue }) });
      }
      ctx.onText?.(textOf({ role: 'assistant', parts }));
      return {
        message: { role: 'assistant', parts },
        stopReason: FINISH[choice.finish_reason] ?? 'other',
        usage: { inputTokens: json.usage?.prompt_tokens ?? 0, outputTokens: json.usage?.completion_tokens ?? 0 },
        model: json.model,
      };
    },
  };
  return checkProvider(provider, opts);
}
