import { decide, type PolicyVerdict } from '../policy.ts';
import type { AccessDecision, Identity, PolicyConfig, Tool, ToolCallPart } from '../types.ts';
import { errorMessage, truncate } from '../util.ts';
import { accessRequest } from './authorizers.ts';
import { IdentityError } from './http.ts';

const MAX_REASON = 200;

/**
 * Local rules first (a local `deny` is final); calls they allow or ask about then go to the PDP when one is set.
 * PDP `deny` → denied with reason `pdp: ...`; PDP failure → `pdp.onError` (default deny). A PDP `allow` keeps the
 * local decision, so an `ask` still needs approval.
 */
export async function authorizeCall(
  policy: PolicyConfig | undefined,
  call: ToolCallPart,
  tool: Tool,
  ctx: { agent: string; identity?: Identity; signal?: AbortSignal },
): Promise<PolicyVerdict> {
  const local = decide(policy, call, tool, ctx.identity);
  const pdp = policy?.pdp;
  if (local.decision === 'deny' || !pdp) return local;
  let decision: AccessDecision;
  try {
    if (!pdp.authorizer || typeof pdp.authorizer.evaluate !== 'function') throw new IdentityError('identity_config', `authorizer "${pdp.type ?? '?'}" was not resolved`);
    decision = await pdp.authorizer.evaluate(accessRequest(call, tool, ctx.agent, ctx.identity, pdp.includeArgs === true), { signal: ctx.signal });
    if (typeof decision?.decision !== 'boolean') throw new IdentityError('pdp_response', 'authorizer returned no boolean decision');
  } catch (err) {
    if (ctx.signal?.aborted) throw err;
    const onError = pdp.onError ?? 'deny';
    const why = `pdp error (${onError}): ${truncate(errorMessage(err), MAX_REASON)}`;
    return onError === 'allow' ? { decision: local.decision, reason: `${local.reason}; ${why}` } : { decision: onError === 'ask' ? 'ask' : 'deny', reason: why };
  }
  if (!decision.decision) return { decision: 'deny', reason: `pdp: ${truncate(decision.reason ?? 'denied', MAX_REASON)}` };
  return { decision: local.decision, reason: `${local.reason}; pdp: allowed` };
}
