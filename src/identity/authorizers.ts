import type { AccessCaller, AccessQuestion, Authorizer, Identity, Tool, ToolCallPart } from '../types.ts';
import { checkSecureUrl, type FetchLike, IDENTITY_LIMITS, IdentityError, requestJson, type ResponseLimits } from './http.ts';

// Self-contained: contract types and node built-ins only, so a gateway outside the agent can reuse these adapters.

export interface HttpAuthorizerOptions extends ResponseLimits {
  url: string;
  /** Extra request headers (e.g. a PDP API key via `${env:...}` in config files). */
  headers?: Record<string, string>;
  /** Default 5 s. */
  timeoutMs?: number;
  allowHttp?: boolean;
  fetch?: FetchLike;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** A string, or the first string of a localised `{lang: text}` object. */
function reasonText(value: unknown): string | undefined {
  if (typeof value === 'string') return value || undefined;
  if (isObject(value)) return Object.values(value).find((v): v is string => typeof v === 'string' && v !== '');
  return undefined;
}

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

/**
 * The AuthZEN access evaluation request of a public question. `authenticated` is true only for a user or agent caller;
 * `risk`, `layer` and `agent` are written after `attrs`, so an attribute never overrides them.
 */
export function authzenRequest(q: AccessQuestion) {
  const { caller: c, target: t } = q;
  return {
    subject: { type: c.kind, id: c.id, properties: { roles: [...c.roles], scopes: [...c.scopes], authenticated: c.kind === 'user' || c.kind === 'agent' } },
    action: { name: q.action },
    resource: { type: t.kind, id: t.id, properties: { ...t.attrs, risk: t.risk, layer: t.layer, agent: t.agent } },
    ...(q.args !== undefined && { context: { args: q.args } }),
  };
}

/**
 * OpenID AuthZEN Authorization API 1.0, access evaluation: `POST {url}/access/v1/evaluation` with the question as
 * `{ subject, action, resource, context? }`, answered `{ decision: boolean, context?: { reason?, reason_user?, ... } }`.
 * `reason_admin` stays with the PDP.
 */
export function authzenAuthorizer(opts: HttpAuthorizerOptions): Authorizer {
  checkSecureUrl(opts.url, 'authzen url', opts.allowHttp);
  const endpoint = `${opts.url.replace(/\/+$/, '')}/access/v1/evaluation`;
  const fetchImpl = opts.fetch ?? fetch;
  return {
    async evaluate(q, eopts) {
      const { body } = await requestJson(fetchImpl, endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...opts.headers },
        body: JSON.stringify(authzenRequest(publicQuestion(q))),
        signal: eopts?.signal,
        timeoutMs: opts.timeoutMs ?? IDENTITY_LIMITS['pdp.timeoutMs'].default,
        maxResponseBytes: opts.maxResponseBytes,
        errorBodyChars: opts.errorBodyChars,
        what: 'AuthZEN',
      });
      if (typeof body?.decision !== 'boolean') throw new IdentityError('pdp_response', 'AuthZEN: response has no boolean "decision"');
      const ctx = isObject(body.context) ? body.context : {};
      const reason = reasonText(ctx.reason) ?? reasonText(ctx.reason_user);
      return { decision: body.decision, ...(reason && { reason }) };
    },
  };
}

/**
 * Open Policy Agent data API: `POST {url}/v1/data/{path}` with `{ input: AccessQuestion }` (`input.caller.roles`,
 * `input.target.risk`), answered `{ result: boolean }` or `{ result: { allow: boolean, reason? } }`. An undefined
 * result is an error (wrong path).
 */
export function opaAuthorizer(opts: HttpAuthorizerOptions & { path?: string }): Authorizer {
  checkSecureUrl(opts.url, 'opa url', opts.allowHttp);
  const path = (opts.path ?? 'agents/allow').replace(/^\/+|\/+$/g, '');
  if (!/^[\w-]+(\/[\w-]+)*$/.test(path)) throw new IdentityError('identity_config', `opa path "${path}" must look like "package/rule"`);
  const endpoint = `${opts.url.replace(/\/+$/, '')}/v1/data/${path}`;
  const fetchImpl = opts.fetch ?? fetch;
  return {
    async evaluate(q, eopts) {
      const { body } = await requestJson(fetchImpl, endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...opts.headers },
        body: JSON.stringify({ input: publicQuestion(q) }),
        signal: eopts?.signal,
        timeoutMs: opts.timeoutMs ?? IDENTITY_LIMITS['pdp.timeoutMs'].default,
        maxResponseBytes: opts.maxResponseBytes,
        errorBodyChars: opts.errorBodyChars,
        what: 'OPA',
      });
      const result = body?.result;
      if (typeof result === 'boolean') return { decision: result };
      if (result && typeof result === 'object' && typeof result.allow === 'boolean') {
        const reason = reasonText(result.reason);
        return { decision: result.allow, ...(reason && { reason }) };
      }
      throw new IdentityError('pdp_response', `OPA: no boolean decision at data.${path.replaceAll('/', '.')}`);
    },
  };
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
