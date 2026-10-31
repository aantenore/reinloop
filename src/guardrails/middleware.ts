import { RunStop } from '../stop.ts';
import type { Guard, GuardStage, GuardVerdict, HookContext, Message, Middleware, Part } from '../types.ts';
import { errorMessage, truncate } from '../util.ts';
import { GUARD_STAGES, parseVerdict } from './contract.ts';

export interface GuardMiddlewareOptions {
  /** What a guard that throws (service down, bad answer) means: `block` (default, fail closed) or `allow` (fail open). */
  onError?: 'block' | 'allow';
  name?: string;
}

/** Longest `reason` kept in events and run results. */
const MAX_REASON = 200;

type Outcome = { text: string; changed: boolean } | { block: { guard: string; reason?: string } };

/**
 * Runs guards at the four checkpoints of a run:
 * - `input`: new user text before each model call (`beforeModel`); redaction changes what the model sees.
 * - `output`: assistant text after each model call (`afterModel`); redaction changes what is persisted and returned.
 * - `tool_args`: the JSON of a call's arguments (`beforeTool`); block denies the call.
 * - `tool_result`: a tool's result (`afterTool`); block replaces it with an error for the model.
 * A block on `input` or `output` ends the run with status `stopped` and reason `guardrail:<guard>:<stage>` (see `RunStop`;
 * a blocked response is not recorded, so its usage is not counted). Guards run in order, the first block wins and
 * redactions chain. Each non-allow verdict is recorded as a `guardrail` event (audit: guard, stage, action, reason; never the text).
 *
 * Text already streamed through `text_delta` before `afterModel` runs is not redacted: consume `model_response` or the
 * run result when output must be clean.
 */
export function guardMiddleware(guards: Guard[], opts: GuardMiddlewareOptions = {}): Middleware {
  const failOpen = opts.onError === 'allow';
  // What the model sees for each user message already checked: history is rebuilt from the original messages every turn.
  const checked = new WeakMap<Message, Message>();

  async function scan(ctx: HookContext, stage: GuardStage, original: string, tool?: string): Promise<Outcome> {
    let text = original;
    for (const guard of guards) {
      if (!(guard.stages ?? GUARD_STAGES).includes(stage) || !text.trim()) continue;
      let verdict: GuardVerdict;
      try {
        verdict = parseVerdict(await guard.check({ stage, text, agent: ctx.agent, runId: ctx.runId, ...(tool && { tool }), ...(ctx.identity && { subject: ctx.identity.subject }) }));
      } catch (err) {
        const reason = truncate(`guard error: ${errorMessage(err)}`, MAX_REASON);
        ctx.emit?.('guardrail', { guard: guard.name, stage, action: failOpen ? 'allow' : 'block', reason });
        if (failOpen) continue;
        return { block: { guard: guard.name, reason } };
      }
      const reason = verdict.reason === undefined ? undefined : truncate(verdict.reason, MAX_REASON);
      if (verdict.action !== 'allow') ctx.emit?.('guardrail', { guard: guard.name, stage, action: verdict.action, ...(reason && { reason }) });
      if (verdict.action === 'block') return { block: { guard: guard.name, ...(reason && { reason }) } };
      if (verdict.action === 'redact') text = verdict.text!;
    }
    return { text, changed: text !== original };
  }

  /** Applies `scan` to every text part; a block ends the run. */
  async function scanParts(ctx: HookContext, stage: 'input' | 'output', parts: Part[]): Promise<Part[] | undefined> {
    let out: Part[] | undefined;
    for (const [i, part] of parts.entries()) {
      if (part.type !== 'text') continue;
      const res = await scan(ctx, stage, part.text);
      if ('block' in res) throw new RunStop(`guardrail:${res.block.guard}:${stage}`, '');
      if (!res.changed) continue;
      out ??= [...parts];
      const { citations: _stale, ...rest } = part; // offsets no longer match the rewritten text
      out[i] = { ...rest, text: res.text };
    }
    return out;
  }

  return {
    name: opts.name ?? 'guardrails',

    async beforeModel(req, ctx) {
      let changed = false;
      const messages: Message[] = [];
      for (const message of req.messages) {
        let seen = message.role === 'user' ? checked.get(message) : message;
        if (!seen) {
          const parts = await scanParts(ctx, 'input', message.parts);
          seen = parts ? { ...message, parts } : message;
          checked.set(message, seen);
        }
        changed ||= seen !== message;
        messages.push(seen);
      }
      return changed ? { ...req, messages } : undefined;
    },

    async afterModel(res, ctx) {
      const parts = await scanParts(ctx, 'output', res.message.parts);
      return parts ? { ...res, message: { ...res.message, parts } } : undefined;
    },

    async beforeTool(call, ctx) {
      const res = await scan(ctx, 'tool_args', JSON.stringify(call.args ?? {}), call.name);
      if ('block' in res) return { deny: `guardrail:${res.block.guard}:tool_args${res.block.reason ? ` (${res.block.reason})` : ''}` };
      if (!res.changed) return undefined;
      try {
        return { ...call, args: JSON.parse(res.text) };
      } catch {
        return { deny: 'guardrail: redacted tool arguments are not valid JSON' };
      }
    },

    async afterTool(result, ctx) {
      const res = await scan(ctx, 'tool_result', result.content, result.name);
      if ('block' in res) {
        return { ...result, isError: true, content: `Tool result withheld by guardrail ${res.block.guard}${res.block.reason ? ` (${res.block.reason})` : ''}.` };
      }
      return res.changed ? { ...result, content: res.text } : undefined;
    },
  };
}
