// Self-contained: only node built-ins and contract types, so these adapters can be reused outside the loop.
import type { LimitSpec } from '../types.ts';

/** Failure of an identity or access component. Messages never contain tokens or secrets. */
export class IdentityError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'IdentityError';
    this.code = code;
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const OIDC = ['oidc'] as const;
const PDP = ['opa', 'authzen'] as const;
const maxResponse = (component: string, path: string, option: string, types: readonly string[]) =>
  ({ component, path, option, default: 1_000_000, min: 1024, safe: [16_384, 10_000_000], types, why: 'Largest JSON document read from the server' }) as const;
const errorBody = (component: string, path: string, option: string, types: readonly string[]) =>
  ({ component, path, option, default: 200, min: 0, types, why: 'Server error text kept in error messages' }) as const;

/** Limits of the identity adapters (verifier, credentials, PDP clients). */
export const IDENTITY_LIMITS = {
  'identity.verifier.timeoutMs': {
    component: 'Identity', path: 'identity.verifier.timeoutMs', option: 'oidcVerifier({ timeoutMs })', default: 5000, min: 1, safe: [500, 30_000], types: OIDC,
    why: 'Time limit of one discovery or JWKS request',
  },
  'identity.verifier.clockSkewSec': {
    component: 'Identity', path: 'identity.verifier.clockSkewSec', option: 'oidcVerifier({ clockSkewSec })', default: 60, min: 0, safe: [0, 300], types: OIDC,
    why: 'Clock drift tolerated when checking exp, nbf and iat',
  },
  'identity.verifier.jwksMinRefreshMs': {
    component: 'Identity', path: 'identity.verifier.jwksMinRefreshMs', option: 'oidcVerifier({ jwksMinRefreshMs })', default: 30_000, min: 0, safe: [1000, 3_600_000], types: OIDC,
    why: 'Shortest gap between JWKS fetches, so unknown key ids cannot flood the IdP',
  },
  'identity.verifier.jwksMaxAgeMs': {
    component: 'Identity', path: 'identity.verifier.jwksMaxAgeMs', option: 'oidcVerifier({ jwksMaxAgeMs })', default: 600_000, min: 1, safe: [60_000, 86_400_000], types: OIDC,
    why: 'How long fetched keys are used before a refresh',
  },
  'identity.verifier.maxTokenAgeSec': {
    component: 'Identity', path: 'identity.verifier.maxTokenAgeSec', option: 'oidcVerifier({ maxTokenAgeSec })', default: 'unbounded', min: 1, unbounded: true, types: OIDC,
    why: 'Oldest token accepted, by iat (off by default)',
  },
  'identity.verifier.maxTokenChars': {
    component: 'Identity', path: 'identity.verifier.maxTokenChars', option: 'oidcVerifier({ maxTokenChars })', default: 16_384, min: 256, safe: [1024, 65_536], types: OIDC,
    why: 'Longest bearer token parsed; longer input is rejected before any work',
  },
  'identity.verifier.maxKeyCandidates': {
    component: 'Identity', path: 'identity.verifier.maxKeyCandidates', option: 'oidcVerifier({ maxKeyCandidates })', default: 5, min: 1, safe: [1, 20], types: OIDC,
    why: 'Keys tried for a token without kid; bounds signature checks per request',
  },
  'identity.verifier.maxResponseBytes': maxResponse('Identity', 'identity.verifier.maxResponseBytes', 'oidcVerifier({ maxResponseBytes })', OIDC),
  'identity.verifier.errorBodyChars': errorBody('Identity', 'identity.verifier.errorBodyChars', 'oidcVerifier({ errorBodyChars })', OIDC),
  'identity.credentials.timeoutMs': {
    component: 'Identity', path: 'identity.credentials.timeoutMs', option: 'oidcCredentials({ timeoutMs })', default: 10_000, min: 1, safe: [500, 60_000], types: OIDC,
    why: 'Time limit of one discovery or token request',
  },
  'identity.credentials.refreshSkewSec': {
    component: 'Identity', path: 'identity.credentials.refreshSkewSec', option: 'oidcCredentials({ refreshSkewSec })', default: 30, min: 0, safe: [0, 300], types: OIDC,
    why: 'Cached tokens are renewed this long before they expire',
  },
  'identity.credentials.defaultTtlSec': {
    component: 'Identity', path: 'identity.credentials.defaultTtlSec', option: 'oidcCredentials({ defaultTtlSec })', default: 60, min: 1, safe: [1, 3600], types: OIDC,
    why: 'Lifetime assumed for an opaque token sent without expires_in',
  },
  'identity.credentials.maxCacheEntries': {
    component: 'Identity', path: 'identity.credentials.maxCacheEntries', option: 'oidcCredentials({ maxCacheEntries })', default: 1000, min: 1, safe: [1, 100_000], types: OIDC,
    why: 'Tokens cached at once',
  },
  'identity.credentials.maxResponseBytes': maxResponse('Identity', 'identity.credentials.maxResponseBytes', 'oidcCredentials({ maxResponseBytes })', OIDC),
  'identity.credentials.errorBodyChars': errorBody('Identity', 'identity.credentials.errorBodyChars', 'oidcCredentials({ errorBodyChars })', OIDC),
  'pdp.timeoutMs': {
    component: 'Identity', path: 'policy.pdp.timeoutMs', also: ['agents.<name>.policy.pdp.timeoutMs'], option: 'opaAuthorizer / authzenAuthorizer({ timeoutMs })', default: 5000,
    min: 1, safe: [100, 30_000], types: PDP, why: 'Time limit of one PDP decision; a timeout is handled by onError',
  },
  'pdp.maxResponseBytes': {
    ...maxResponse('Identity', 'policy.pdp.maxResponseBytes', 'opaAuthorizer / authzenAuthorizer({ maxResponseBytes })', PDP), also: ['agents.<name>.policy.pdp.maxResponseBytes'],
  },
  'pdp.errorBodyChars': {
    ...errorBody('Identity', 'policy.pdp.errorBodyChars', 'opaAuthorizer / authzenAuthorizer({ errorBodyChars })', PDP), also: ['agents.<name>.policy.pdp.errorBodyChars'],
  },
  'pdp.maxReasonChars': {
    component: 'Identity', path: 'policy.pdp.maxReasonChars', also: ['agents.<name>.policy.pdp.maxReasonChars'], option: 'PolicyConfig.pdp.maxReasonChars', default: 200, min: 20,
    why: 'Characters of a PDP reason or error kept in the decision',
  },
} as const satisfies Record<string, LimitSpec>;

/** Largest JSON document read from an IdP or PDP (discovery, JWKS, token, decision) by default. */
export const MAX_RESPONSE_BYTES: number = IDENTITY_LIMITS['identity.verifier.maxResponseBytes'].default;
const ERROR_BODY_CHARS: number = IDENTITY_LIMITS['identity.verifier.errorBodyChars'].default;

/** Size and excerpt limits of `requestJson`. */
export interface ResponseLimits {
  /** Largest response read (default 1 MB). */
  maxResponseBytes?: number;
  /** Server error text kept in error messages (default 200). */
  errorBodyChars?: number;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Rejects plain-HTTP URLs except on loopback hosts, unless explicitly allowed. */
export function checkSecureUrl(url: string, what: string, allowHttp = false): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new IdentityError('identity_config', `${what}: invalid URL "${url}"`);
  }
  if (parsed.protocol === 'https:') return parsed;
  if (parsed.protocol === 'http:' && (allowHttp || LOOPBACK.has(parsed.hostname) || parsed.hostname.endsWith('.localhost'))) return parsed;
  throw new IdentityError('identity_config', `${what}: "${url}" must use https (plain http is accepted only on loopback hosts or with allowHttp)`);
}

/** Sends a request and parses a bounded JSON body. Non-2xx answers reject with the status and a short excerpt. */
export async function requestJson(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit & { timeoutMs: number; what: string } & ResponseLimits,
): Promise<{ status: number; body: any }> {
  const { timeoutMs, what, signal, maxResponseBytes = MAX_RESPONSE_BYTES, errorBodyChars = ERROR_BODY_CHARS, ...rest } = init;
  const timeout = AbortSignal.timeout(timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(url, { ...rest, redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new IdentityError('identity_unreachable', `${what}: request failed (${timeout.aborted ? `timed out after ${timeoutMs}ms` : (err as Error).message})`);
  }
  const text = await res.text();
  if (text.length > maxResponseBytes) throw new IdentityError('identity_response', `${what}: response too large`);
  let body: any;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  if (!res.ok) {
    const detail = body && typeof body === 'object' && typeof body.error === 'string'
      ? `${body.error}${typeof body.error_description === 'string' ? `: ${body.error_description.slice(0, errorBodyChars)}` : ''}`
      : text.slice(0, errorBodyChars);
    throw new IdentityError('identity_response', `${what}: HTTP ${res.status}${detail ? ` (${detail})` : ''}`);
  }
  if (body === undefined) throw new IdentityError('identity_response', `${what}: response is not JSON`);
  return { status: res.status, body };
}

/** Fetches and checks an OpenID Provider configuration document (OpenID Connect Discovery 1.0). */
export async function discover(fetchImpl: FetchLike, issuer: string, timeoutMs: number, allowHttp?: boolean, limits: ResponseLimits = {}): Promise<Record<string, unknown>> {
  checkSecureUrl(issuer, 'issuer', allowHttp);
  const url = `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
  const { body } = await requestJson(fetchImpl, url, { method: 'GET', headers: { accept: 'application/json' }, timeoutMs, what: 'OIDC discovery', ...limits });
  // The document must name the issuer it was fetched for (mix-up defence).
  if (body?.issuer !== issuer) throw new IdentityError('identity_config', `OIDC discovery: issuer mismatch (expected "${issuer}", got "${String(body?.issuer)}")`);
  return body;
}
