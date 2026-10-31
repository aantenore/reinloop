import type { Identity, IdentityVerifier } from '../types.ts';
import { checkSecureUrl, discover, type FetchLike, IdentityError, requestJson } from './http.ts';
import { candidateKeys, checkAlgorithm, decodeJwt, importKey, type Jwk, verifySignature } from './jwt.ts';

export interface OidcVerifierOptions {
  /** Expected `iss`, exactly as the provider publishes it (also the discovery base URL). */
  issuer: string;
  /** Accepted `aud` value(s). Strongly recommended: without it any token of the issuer is accepted, ID tokens included. */
  audience?: string | string[];
  /** Skip discovery and read keys from this URL. */
  jwksUri?: string;
  /** Tolerance for `exp`, `nbf` and `iat`, in seconds (default 60). */
  clockSkewSec?: number;
  /** Accepted asymmetric algorithms (default RS256, ES256). `none` and `HS*` are always refused. */
  algorithms?: string[];
  /** Reject tokens issued longer ago than this (`iat`), in seconds. Off by default. */
  maxTokenAgeSec?: number;
  /** Minimum interval between JWKS fetches triggered by an unknown `kid` or a failed fetch (default 30 s). */
  jwksMinRefreshMs?: number;
  /** JWKS cache lifetime (default 10 min). */
  jwksMaxAgeMs?: number;
  /** Timeout of discovery and JWKS requests (default 5 s). */
  timeoutMs?: number;
  /** Accept plain-HTTP issuer and JWKS URLs on non-loopback hosts (default false). */
  allowHttp?: boolean;
  /** Clients whose `resource_access` roles are included (default: all clients). */
  roleClients?: string[];
  /** Overrides how `Identity.kind` is derived from the verified claims. */
  kind?: (claims: Record<string, unknown>) => 'user' | 'agent';
  fetch?: FetchLike;
  /** Clock in milliseconds (tests). */
  now?: () => number;
}

export const DEFAULT_ALGORITHMS = ['RS256', 'ES256'];

const invalid = (why: string) => new IdentityError('invalid_token', why);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? [v] : []);

/**
 * Client-credentials tokens are the agent's own identity. Recognised when the subject is the client itself
 * (RFC 9068: `sub` equals `client_id`/`azp`, or there is no `sub`) or a Keycloak service-account user.
 */
export function defaultKind(claims: Record<string, unknown>): 'user' | 'agent' {
  const { sub, client_id, azp, preferred_username } = claims;
  if (sub === undefined) return 'agent';
  if (sub === client_id || sub === azp) return 'agent';
  if (typeof preferred_username === 'string' && preferred_username.startsWith('service-account-')) return 'agent';
  return 'user';
}

/** Roles from Keycloak-style `realm_access` / `resource_access` and a plain `roles` claim, deduplicated. */
export function rolesOf(claims: Record<string, unknown>, roleClients?: string[]): string[] {
  const out = new Set<string>(strings((claims.realm_access as { roles?: unknown } | undefined)?.roles));
  const resources = claims.resource_access;
  if (resources && typeof resources === 'object') {
    for (const [client, access] of Object.entries(resources as Record<string, { roles?: unknown }>)) {
      if (roleClients && !roleClients.includes(client)) continue;
      for (const r of strings(access?.roles)) out.add(r);
    }
  }
  for (const r of strings(claims.roles)) out.add(r);
  return [...out];
}

/** Scopes from `scope` (space separated, RFC 8693/9068) and `scp` (array or string). */
export function scopesOf(claims: Record<string, unknown>): string[] {
  const out = new Set<string>();
  for (const s of [...strings(claims.scope), ...strings(claims.scp)]) for (const part of s.split(' ')) if (part) out.add(part);
  return [...out];
}

/**
 * Verifies JWT access tokens of an OpenID provider: keys come from discovery + JWKS (cached, refreshed on an unknown
 * `kid`, rate limited), signatures are checked with node:crypto, then `iss`, `aud`, `exp`, `nbf` and `iat`.
 */
export function oidcVerifier(opts: OidcVerifierOptions): IdentityVerifier & { refresh(): Promise<void> } {
  if (!opts?.issuer) throw new IdentityError('identity_config', 'oidcVerifier: "issuer" is required');
  checkSecureUrl(opts.issuer, 'issuer', opts.allowHttp);
  if (opts.jwksUri) checkSecureUrl(opts.jwksUri, 'jwksUri', opts.allowHttp);
  const algorithms = opts.algorithms ?? DEFAULT_ALGORITHMS;
  for (const alg of algorithms) checkAlgorithm(alg, algorithms);
  const audiences = opts.audience === undefined ? undefined : strings(opts.audience);
  const skew = opts.clockSkewSec ?? 60;
  const minRefresh = opts.jwksMinRefreshMs ?? 30_000;
  const maxAge = opts.jwksMaxAgeMs ?? 600_000;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const fetchImpl: FetchLike = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const kindOf = opts.kind ?? defaultKind;

  let keys: Jwk[] | undefined;
  let fetchedAt = 0;
  let lastAttempt = -Infinity;
  let lastError: unknown;
  let inflight: Promise<void> | undefined;
  let jwksUri = opts.jwksUri;

  const load = async () => {
    if (!jwksUri) {
      const doc = await discover(fetchImpl, opts.issuer, timeoutMs, opts.allowHttp);
      if (typeof doc.jwks_uri !== 'string') throw new IdentityError('identity_config', 'OIDC discovery: no "jwks_uri"');
      jwksUri = checkSecureUrl(doc.jwks_uri, 'jwks_uri', opts.allowHttp).href;
    }
    const { body } = await requestJson(fetchImpl, jwksUri, { method: 'GET', headers: { accept: 'application/json' }, timeoutMs, what: 'JWKS' });
    if (!Array.isArray(body?.keys)) throw new IdentityError('identity_response', 'JWKS: no "keys" array');
    keys = body.keys;
    fetchedAt = now();
  };

  const refresh = (): Promise<void> => {
    inflight ??= (async () => {
      lastAttempt = now();
      try {
        await load();
        lastError = undefined;
      } catch (err) {
        lastError = err;
        if (!keys) throw err; // keep serving the previous key set during an outage
      }
    })().finally(() => (inflight = undefined));
    return inflight;
  };

  const getKeys = async (unknownKid: boolean): Promise<Jwk[]> => {
    const limited = now() - lastAttempt < minRefresh;
    const stale = !keys || now() - fetchedAt > maxAge;
    if (!keys && limited && lastError) throw lastError;
    if ((stale && !limited) || !keys || (unknownKid && !limited)) await refresh();
    return keys ?? [];
  };

  return {
    refresh,
    async verify(token, _vopts) {
      const jwt = decodeJwt(token);
      const alg = jwt.header.alg;
      checkAlgorithm(alg, algorithms);
      if (jwt.header.crit !== undefined) throw invalid('token uses unsupported critical header parameters');
      const kid = jwt.header.kid;

      let candidates = candidateKeys(await getKeys(false), alg, kid);
      if (!candidates.length && kid !== undefined) candidates = candidateKeys(await getKeys(true), alg, kid);
      if (!candidates.length) throw invalid('no signing key matches the token');
      // Without a `kid` a few same-type keys are tried; a known `kid` never triggers a refetch on a bad signature.
      if (!candidates.slice(0, 5).some((k) => verifySignature(jwt, importKey(k, alg)))) throw invalid('invalid token signature');

      const c = jwt.payload;
      const t = now() / 1000;
      if (c.iss !== opts.issuer) throw invalid('token issuer mismatch');
      if (audiences) {
        const aud = strings(c.aud);
        if (!aud.some((a) => audiences.includes(a))) throw invalid('token audience mismatch');
      }
      if (typeof c.exp !== 'number' || !Number.isFinite(c.exp)) throw invalid('token has no "exp"');
      if (t > c.exp + skew) throw invalid('token expired');
      if (c.nbf !== undefined && (typeof c.nbf !== 'number' || t + skew < c.nbf)) throw invalid('token not yet valid');
      if (c.iat !== undefined) {
        if (typeof c.iat !== 'number' || c.iat > t + skew) throw invalid('token "iat" is in the future');
        if (opts.maxTokenAgeSec !== undefined && t - c.iat > opts.maxTokenAgeSec + skew) throw invalid('token too old');
      } else if (opts.maxTokenAgeSec !== undefined) throw invalid('token has no "iat"');

      const kind = kindOf(c);
      const subject = typeof c.sub === 'string' && c.sub ? c.sub : kind === 'agent' ? [c.client_id, c.azp].find((v): v is string => typeof v === 'string' && !!v) : undefined;
      if (!subject) throw invalid('token has no subject');
      return { subject, kind, roles: rolesOf(c, opts.roleClients), scopes: scopesOf(c), claims: c, token } satisfies Identity;
    },
  };
}
