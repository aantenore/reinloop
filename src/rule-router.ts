// Self-contained on purpose (contract types only), so the router can be reused without the rest of the runtime.
import type { HookContext, ModelRequest, ModelRouter } from './types.ts';

/** All set conditions must hold. */
export interface RouteCondition {
  /** Context size estimate of the request (the `estTokens` of its `model_request` event). */
  minEstTokens?: number;
  maxEstTokens?: number;
  /** Whether the request offers any tool. */
  hasTools?: boolean;
  /** The request is for this turn (1-based) or a later one. */
  turnAtLeast?: number;
}

/** `model` is a model spec: a `models` alias or `"provider/model"` (anything the resolver understands). */
export interface RouteRule { when: RouteCondition; model: string }

export interface RuleRouterOptions { rules: RouteRule[]; default: string }

/** Rough token estimate (~4 chars/token), as used for the `model_request` event. */
const estimate = (value: unknown): number => Math.ceil((typeof value === 'string' ? value : (JSON.stringify(value) ?? '')).length / 4);

/** Same estimate as the `model_request` event: the last real usage plus an estimate for what was added since. */
function estimateRequest(req: ModelRequest, ctx: HookContext): number {
  const { lastUsage, lastUsageAt, messages } = ctx.state;
  if (lastUsage && lastUsageAt !== undefined) return lastUsage.inputTokens + lastUsage.outputTokens + estimate(messages.slice(lastUsageAt));
  return estimate(req.instructions ?? '') + estimate(req.tools) + estimate(req.messages);
}

const matches = (when: RouteCondition, req: ModelRequest, ctx: HookContext): boolean => {
  if (when.hasTools !== undefined && (req.tools.length > 0) !== when.hasTools) return false;
  if (when.turnAtLeast !== undefined && ctx.state.turns + 1 < when.turnAtLeast) return false;
  if (when.minEstTokens !== undefined || when.maxEstTokens !== undefined) {
    const est = estimateRequest(req, ctx);
    if (when.minEstTokens !== undefined && est < when.minEstTokens) return false;
    if (when.maxEstTokens !== undefined && est > when.maxEstTokens) return false;
  }
  return true;
};

/** Zero-cost router: the first rule whose conditions all hold picks the model, else `default`. */
export function ruleRouter(opts: RuleRouterOptions): ModelRouter & { readonly models: string[] } {
  if (!opts.default || typeof opts.default !== 'string') throw new Error('ruleRouter requires a default model');
  const rules = opts.rules ?? [];
  for (const [i, r] of rules.entries()) {
    if (!r || typeof r.model !== 'string' || !r.model) throw new Error(`ruleRouter rule ${i} needs a model`);
    if (typeof r.when !== 'object' || r.when === null) throw new Error(`ruleRouter rule ${i} needs a "when" object`);
  }
  return {
    models: [...new Set([...rules.map((r) => r.model), opts.default])],
    select: (req, ctx) => rules.find((r) => matches(r.when, req, ctx))?.model ?? opts.default,
  };
}
