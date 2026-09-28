import type { Budget, Decision, PolicyConfig, Risk, RunState, Tool, ToolCallPart } from './types.ts';
import { globToRegExp } from './util.ts';

/** Applied when an agent sets no budget, so a confused model cannot loop forever. */
export const DEFAULT_BUDGET: Budget = { maxTurns: 50 };

export const DEFAULT_RISK_DECISIONS: Record<Risk, Decision> = { read: 'allow', write: 'ask', exec: 'ask' };

export interface PolicyVerdict { decision: Decision; reason: string }

/** First matching rule wins; then per-risk defaults; then the policy default. */
export function decide(policy: PolicyConfig | undefined, call: ToolCallPart, tool: Tool): PolicyVerdict {
  for (const rule of policy?.rules ?? []) {
    const nameOk = rule.match === undefined || globToRegExp(rule.match).test(call.name);
    const riskOk = rule.risk === undefined || rule.risk === tool.risk;
    if (nameOk && riskOk) {
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
