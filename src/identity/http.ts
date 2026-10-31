// Self-contained: only node built-ins and contract types, so these adapters can be reused outside the loop.

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

/** Largest JSON document read from an IdP or PDP (discovery, JWKS, token, decision). */
export const MAX_RESPONSE_BYTES = 1_000_000;

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
  init: RequestInit & { timeoutMs: number; what: string },
): Promise<{ status: number; body: any }> {
  const { timeoutMs, what, signal, ...rest } = init;
  const timeout = AbortSignal.timeout(timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(url, { ...rest, redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new IdentityError('identity_unreachable', `${what}: request failed (${timeout.aborted ? `timed out after ${timeoutMs}ms` : (err as Error).message})`);
  }
  const text = await res.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new IdentityError('identity_response', `${what}: response too large`);
  let body: any;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  if (!res.ok) {
    const detail = body && typeof body === 'object' && typeof body.error === 'string'
      ? `${body.error}${typeof body.error_description === 'string' ? `: ${body.error_description.slice(0, 200)}` : ''}`
      : text.slice(0, 200);
    throw new IdentityError('identity_response', `${what}: HTTP ${res.status}${detail ? ` (${detail})` : ''}`);
  }
  if (body === undefined) throw new IdentityError('identity_response', `${what}: response is not JSON`);
  return { status: res.status, body };
}

/** Fetches and checks an OpenID Provider configuration document (OpenID Connect Discovery 1.0). */
export async function discover(fetchImpl: FetchLike, issuer: string, timeoutMs: number, allowHttp?: boolean): Promise<Record<string, unknown>> {
  checkSecureUrl(issuer, 'issuer', allowHttp);
  const url = `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
  const { body } = await requestJson(fetchImpl, url, { method: 'GET', headers: { accept: 'application/json' }, timeoutMs, what: 'OIDC discovery' });
  // The document must name the issuer it was fetched for (mix-up defence).
  if (body?.issuer !== issuer) throw new IdentityError('identity_config', `OIDC discovery: issuer mismatch (expected "${issuer}", got "${String(body?.issuer)}")`);
  return body;
}
