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
 * - `input`: new user text before it is recorded (`beforeInput`; `beforeModel` for older history); redaction changes
 *   what is persisted and what the model sees.
 * - `output`: assistant text after each model call (`afterModel`); redaction changes what is persisted and returned.
 * - `tool_args`: the JSON of a call's arguments (`beforeTool`); block denies the call.
 * - `tool_result`: a tool's result (`afterTool`); block replaces it with an error for the model.
 * A block on `input` or `output` ends the run with status `stopped` and reason `guardrail:<guard>:<stage>` (see `RunStop`;
 * a blocked response is not recorded, so its usage is not counted). Guards run in order, the first block wins and
 * redactions chain. Each non-allow verdict is recorded as a `guardrail` event (audit: guard, stage, action, reason; never the text).
 *
 * With an `output` guard the middleware sets `holdsText`: `text_delta` carries the checked text once, after the answer
 * is complete, instead of streaming the raw tokens (no streamed text bypasses the guard; streaming latency is lost).
 */
export function guardMiddleware(guards: Guard[], opts: GuardMiddlewareOptions = {}): Middleware {
  const failOpen = opts.onError === 'allow';
  // Each user message checked so far -> what the model sees (or the block); redacted messages map to themselves.
  const checked = new WeakMap<Message, Message | { blocked: string }>();

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

  /** Applies `scan` to every text part; the first block is returned instead of the parts. */
  async function scanParts(ctx: HookContext, stage: 'input' | 'output', parts: Part[]): Promise<Part[] | undefined | { blocked: string }> {
    let out: Part[] | undefined;
    for (const [i, part] of parts.entries()) {
      if (part.type !== 'text') continue;
      const res = await scan(ctx, stage, part.text);
      if ('block' in res) return { blocked: `guardrail:${res.block.guard}:${stage}` };
      if (!res.changed) continue;
      out ??= [...parts];
      const { citations: _stale, ...rest } = part; // offsets no longer match the rewritten text
      out[i] = { ...rest, text: res.text };
    }
    return out;
  }

  /** The user message as the model may see it, or the block reason; checked once per message object. */
  async function checkInput(ctx: HookContext, message: Message): Promise<Message | { blocked: string }> {
    let seen = checked.get(message);
    if (!seen) {
      const parts = await scanParts(ctx, 'input', message.parts);
      seen = parts && 'blocked' in parts ? parts : parts ? { ...message, parts } : message;
      checked.set(message, seen);
      if (!('blocked' in seen)) checked.set(seen, seen);
    }
    return seen;
  }

  return {
    name: opts.name ?? 'guardrails',
    holdsText: guards.some((g) => (g.stages ?? GUARD_STAGES).includes('output')),

    // Redacted input is what gets persisted: the raw text is never recorded. A blocked input is recorded as received
    // (the audit trail of what was refused) and the run stops before the model call.
    async beforeInput(message, ctx) {
      if (message.role !== 'user') return undefined;
      const seen = await checkInput(ctx, message);
      return 'blocked' in seen || seen === message ? undefined : seen;
    },

    // Fallback for user messages that did not pass `beforeInput` (history recorded before the guard was added, or
    // loaded from the store on resume): checked here, in the request only.
    async beforeModel(req, ctx) {
      let changed = false;
      const messages: Message[] = [];
      for (const message of req.messages) {
        const seen = message.role === 'user' ? await checkInput(ctx, message) : message;
        if ('blocked' in seen) throw new RunStop(seen.blocked, '');
        changed ||= seen !== message;
        messages.push(seen);
      }
      return changed ? { ...req, messages } : undefined;
    },

    async afterModel(res, ctx) {
      const parts = await scanParts(ctx, 'output', res.message.parts);
      if (parts && 'blocked' in parts) throw new RunStop(parts.blocked, '');
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
