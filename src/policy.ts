import type { Budget, Decision, Identity, PolicyCondition, PolicyConfig, Risk, RunState, Tool, ToolCallPart } from './types.ts';
import { limitDefault } from './limits.ts';
import { globToRegExp } from './util.ts';

/** Applied when an agent sets no budget, so a confused model cannot loop forever. */
/** Budget of an agent that sets none. */
export const DEFAULT_BUDGET: Budget = { maxTurns: limitDefault('limits.maxTurns') };

export const DEFAULT_RISK_DECISIONS: Record<Risk, Decision> = { read: 'allow', write: 'ask', exec: 'ask' };

export interface PolicyVerdict { decision: Decision; reason: string }

/** True when the identity satisfies every set field of `when` (roles and scopes: any-of; kind: equal). */
export function matchesCondition(when: PolicyCondition | undefined, identity: Identity | undefined): boolean {
  if (!when) return true;
  if (!identity) return false;
  if (when.kind !== undefined && when.kind !== identity.kind) return false;
  if (when.roles && !when.roles.some((r) => identity.roles?.includes(r))) return false;
  if (when.scopes && !when.scopes.some((s) => identity.scopes?.includes(s))) return false;
  return true;
}

/** First matching rule wins; then per-risk defaults; then the policy default. */
export function decide(policy: PolicyConfig | undefined, call: ToolCallPart, tool: Tool, identity?: Identity): PolicyVerdict {
  for (const rule of policy?.rules ?? []) {
    const nameOk = rule.match === undefined || globToRegExp(rule.match).test(call.name);
    const riskOk = rule.risk === undefined || rule.risk === tool.risk;
    if (nameOk && riskOk && matchesCondition(rule.when, identity)) {
      return { decision: rule.action, reason: rule.reason ?? `rule ${rule.match ?? '*'}${rule.risk ? `/${rule.risk}` : ''}` };
    }
  }
  if (tool.risk) {
    const decision = policy?.risk?.[tool.risk] ?? DEFAULT_RISK_DECISIONS[tool.risk];
    return { decision, reason: `risk ${tool.risk}` };
  }
  // Tools without a risk label are the developer's own code: trusted unless the policy says otherwise.
  return { decision: policy?.default ?? 'allow', reason: 'default' };
}

/** Merge agent-level policy over a global one: agent rules are evaluated first. */
export function mergePolicies(base: PolicyConfig | undefined, override: PolicyConfig | undefined): PolicyConfig | undefined {
  if (!base) return override;
  if (!override) return base;
  return {
    default: override.default ?? base.default,
    risk: { ...base.risk, ...override.risk },
    rules: [...(override.rules ?? []), ...(base.rules ?? [])],
    ...((override.pdp ?? base.pdp) && { pdp: override.pdp ?? base.pdp }),
  };
}

/** Returns the exceeded budget name, or undefined when the run may continue. */
export function exceededBudget(
  budget: Budget | undefined,
  state: Pick<RunState, 'turns' | 'toolCalls' | 'usage' | 'costUsd'>,
  elapsedMs: number,
): string | undefined {
  if (!budget) return undefined;
  const total = state.usage.inputTokens + state.usage.outputTokens;
  if (budget.maxTurns !== undefined && state.turns >= budget.maxTurns) return 'maxTurns';
  if (budget.maxToolCalls !== undefined && state.toolCalls >= budget.maxToolCalls) return 'maxToolCalls';
  if (budget.maxInputTokens !== undefined && state.usage.inputTokens >= budget.maxInputTokens) return 'maxInputTokens';
  if (budget.maxOutputTokens !== undefined && state.usage.outputTokens >= budget.maxOutputTokens) return 'maxOutputTokens';
  if (budget.maxTotalTokens !== undefined && total >= budget.maxTotalTokens) return 'maxTotalTokens';
  if (budget.maxCostUsd !== undefined && state.costUsd >= budget.maxCostUsd) return 'maxCostUsd';
  if (budget.maxDurationMs !== undefined && elapsedMs >= budget.maxDurationMs) return 'maxDurationMs';
  return undefined;
}
