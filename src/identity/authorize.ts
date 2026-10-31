import { limitDefault } from '../limits.ts';
import { decide, type PolicyVerdict } from '../policy.ts';
import type { AccessCaller, AccessDecision, AccessQuestion, Identity, PolicyConfig, Tool, ToolCallPart } from '../types.ts';
import { errorMessage, truncate } from '../util.ts';

/**
 * Failure of an identity or access component (verifier, credentials, authorizer). Messages never contain tokens or
 * secrets. A `code` starting with `identity_` means the provider is unavailable or misconfigured: `serve` answers 503
 * instead of 401.
 */
export class IdentityError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'IdentityError';
    this.code = code;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** The caller of a run without a verified identity. */
const anonymous = (): AccessCaller => ({ kind: 'anonymous', id: 'anonymous', roles: [], scopes: [] });

/**
 * The question as it may leave the process. Only a caller of kind `user` or `agent` with a non-empty id is kept (roles
 * and scopes as string lists, never a token); anything else becomes the anonymous caller.
 */
export function publicQuestion(q: AccessQuestion): AccessQuestion {
  const c = (isObject(q?.caller) ? q.caller : {}) as Partial<AccessCaller>;
  const known = (c.kind === 'user' || c.kind === 'agent') && typeof c.id === 'string' && c.id !== '';
  const caller: AccessCaller = known
    ? { id: c.id!, kind: c.kind!, roles: strings(c.roles), scopes: strings(c.scopes), ...(typeof c.name === 'string' && { name: c.name }) }
    : anonymous();
  return { caller, action: q.action, target: structuredClone(q.target), ...(q.args !== undefined && { args: structuredClone(q.args) }) };
}

/** The question for one tool call. A run without identity is the anonymous caller, never the agent; a tool without a risk label asks as `exec`. */
export function accessQuestion(call: ToolCallPart, tool: Tool, agent: string, identity: Identity | undefined, includeArgs = false): AccessQuestion {
  return publicQuestion({
    caller: identity ? { id: identity.subject, kind: identity.kind, roles: identity.roles ?? [], scopes: identity.scopes ?? [] } : anonymous(),
    action: 'call',
    target: { kind: 'tool', id: tool.name, layer: tool.layer ?? (tool.hosted ? 'llm' : 'tool'), risk: tool.risk ?? 'exec', agent },
    ...(includeArgs && { args: call.args }),
  });
}

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
  const maxReason = typeof pdp.maxReasonChars === 'number' ? pdp.maxReasonChars : limitDefault('pdp.maxReasonChars');
  let decision: AccessDecision;
  try {
    if (!pdp.authorizer || typeof pdp.authorizer.evaluate !== 'function') throw new IdentityError('identity_config', `authorizer "${pdp.type ?? '?'}" was not resolved`);
    decision = await pdp.authorizer.evaluate(accessQuestion(call, tool, ctx.agent, ctx.identity, pdp.includeArgs === true), { signal: ctx.signal });
    if (typeof decision?.decision !== 'boolean') throw new IdentityError('pdp_response', 'authorizer returned no boolean decision');
  } catch (err) {
    if (ctx.signal?.aborted) throw err;
    const onError = pdp.onError ?? 'deny';
    const why = `pdp error (${onError}): ${truncate(errorMessage(err), maxReason)}`;
    return onError === 'allow' ? { decision: local.decision, reason: `${local.reason}; ${why}` } : { decision: onError === 'ask' ? 'ask' : 'deny', reason: why };
  }
  if (!decision.decision) return { decision: 'deny', reason: `pdp: ${truncate(decision.reason ?? 'denied', maxReason)}` };
  return { decision: local.decision, reason: `${local.reason}; pdp: allowed` };
}
