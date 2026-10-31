import { validate } from '../schema.ts';
import type { JsonSchema, ModelParams, ModelRequest, ModelResponse, Provider, StopReason } from '../types.ts';
import { errorMessage, textOf, toolCallsOf, userMessage } from '../util.ts';

export interface ProviderCheckOptions {
  /** Model id sent to the provider. */
  model: string;
  signal?: AbortSignal;
  /** Sampling settings for every turn (e.g. `maxTokens` for models that reason before answering). */
  params?: ModelParams;
}

const STOP_REASONS: StopReason[] = ['end', 'tool_calls', 'max_tokens', 'refusal', 'pause_turn', 'other'];
const NUMBER_SCHEMA: JsonSchema = { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'], additionalProperties: false };

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
      failures.push(`${label}: generate() threw: ${errorMessage(err)}`);
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

  const plain = await turn('text turn', { messages: [userMessage('Reply with the single word: pong')], tools: [] });
  if (plain && common('text turn', plain.res, plain.streamed)) {
    const { res } = plain;
    if (!textOf(res.message).trim()) failures.push('text turn: empty answer text');
    if (toolCallsOf(res.message).length) failures.push('text turn: tool calls returned although no tools were offered');
    if (res.stopReason !== 'end' && res.stopReason !== 'max_tokens') failures.push(`text turn: expected stopReason "end", got "${res.stopReason}"`);
  }

  const tool = { name: 'record_number', description: 'Record a number.', schema: NUMBER_SCHEMA };
  const forced = await turn('tool turn', {
    instructions: 'You must call the record_number tool with n=42. Do not answer in text.',
    messages: [userMessage('Record the number 42.')],
    tools: [tool],
  });
  if (forced && common('tool turn', forced.res, forced.streamed)) {
    const calls = toolCallsOf(forced.res.message);
    const call = calls.find((c) => c.name === tool.name);
    if (!call) failures.push(`tool turn: expected a call to "${tool.name}", got ${calls.length ? calls.map((c) => c.name).join(', ') : 'none'}`);
    else {
      if (!call.id) failures.push('tool turn: tool call has no id');
      if (call.argsIssue) failures.push(`tool turn: arguments were not valid JSON (${call.argsIssue.error})`);
      else {
        const problems = validate(tool.schema, call.args);
        if (problems.length) failures.push(`tool turn: arguments do not match the schema: ${problems.join('; ')}`);
      }
      if (forced.res.stopReason !== 'tool_calls') failures.push(`tool turn: expected stopReason "tool_calls", got "${forced.res.stopReason}"`);
    }
  }

  return failures;
}
