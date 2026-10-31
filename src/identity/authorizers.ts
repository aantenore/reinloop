import type { AccessRequest, Authorizer, Identity, Tool, ToolCallPart } from '../types.ts';
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

function reasonText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return JSON.stringify(value);
  return undefined;
}

/**
 * OpenID AuthZEN Authorization API 1.0, access evaluation: `POST {url}/access/v1/evaluation` with the AccessRequest,
 * answered `{ decision: boolean, context?: { reason?, reason_admin?, ... } }`.
 */
export function authzenAuthorizer(opts: HttpAuthorizerOptions): Authorizer {
  checkSecureUrl(opts.url, 'authzen url', opts.allowHttp);
  const endpoint = `${opts.url.replace(/\/+$/, '')}/access/v1/evaluation`;
  const fetchImpl = opts.fetch ?? fetch;
  return {
    async evaluate(req, eopts) {
      const { body } = await requestJson(fetchImpl, endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...opts.headers },
        body: JSON.stringify(req),
        signal: eopts?.signal,
        timeoutMs: opts.timeoutMs ?? IDENTITY_LIMITS['pdp.timeoutMs'].default,
        maxResponseBytes: opts.maxResponseBytes,
        errorBodyChars: opts.errorBodyChars,
        what: 'AuthZEN',
      });
      if (typeof body?.decision !== 'boolean') throw new IdentityError('pdp_response', 'AuthZEN: response has no boolean "decision"');
      const ctx = body.context ?? {};
      const reason = reasonText(ctx.reason) ?? reasonText(ctx.reason_admin) ?? reasonText(ctx.reason_user);
      return { decision: body.decision, ...(reason && { reason }) };
    },
  };
}

/**
 * Open Policy Agent data API: `POST {url}/v1/data/{path}` with `{ input: AccessRequest }`, answered
 * `{ result: boolean }` or `{ result: { allow: boolean, reason? } }`. An undefined result is an error (wrong path).
 */
export function opaAuthorizer(opts: HttpAuthorizerOptions & { path?: string }): Authorizer {
  checkSecureUrl(opts.url, 'opa url', opts.allowHttp);
  const path = (opts.path ?? 'agents/allow').replace(/^\/+|\/+$/g, '');
  if (!/^[\w-]+(\/[\w-]+)*$/.test(path)) throw new IdentityError('identity_config', `opa path "${path}" must look like "package/rule"`);
  const endpoint = `${opts.url.replace(/\/+$/, '')}/v1/data/${path}`;
  const fetchImpl = opts.fetch ?? fetch;
  return {
    async evaluate(req, eopts) {
      const { body } = await requestJson(fetchImpl, endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...opts.headers },
        body: JSON.stringify({ input: req }),
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

/**
 * The AuthZEN-shaped request for one tool call. A run without identity is the agent acting on its own authority:
 * subject `{ type: 'agent', id: 'agent:<name>' }` with `authenticated: false`.
 */
export function accessRequest(call: ToolCallPart, tool: Tool, agent: string, identity: Identity | undefined, includeArgs = false): AccessRequest {
  return {
    subject: identity
      ? { type: identity.kind, id: identity.subject, properties: { roles: identity.roles ?? [], scopes: identity.scopes ?? [], authenticated: true } }
      : { type: 'agent', id: `agent:${agent}`, properties: { roles: [], scopes: [], authenticated: false } },
    action: { name: 'call' },
    resource: { type: 'tool', id: tool.name, properties: { risk: tool.risk ?? null, agent, layer: tool.layer ?? (tool.hosted ? 'llm' : 'tool') } },
    ...(includeArgs && { context: { args: call.args } }),
  };
}
