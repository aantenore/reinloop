import { createHash } from 'node:crypto';
import type { CredentialProvider, Identity } from '../types.ts';
import { checkSecureUrl, discover, type FetchLike, IdentityError, requestJson } from './http.ts';
import { unverifiedExpiry } from './jwt.ts';

/** Binds outbound credentials to the identity of one run (resolved at run start). */
export type CredentialFactory = (identity?: Identity) => CredentialProvider;

export const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
export const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';

export interface OidcCredentialsOptions {
  /** Issuer for discovery of `token_endpoint`; or pass `tokenEndpoint` directly. */
  issuer?: string;
  tokenEndpoint?: string;
  clientId: string;
  clientSecret: string;
  /** `on-behalf-of`: RFC 8693 token exchange of the caller's token; `self`: client_credentials (the agent's own identity). */
  mode: 'on-behalf-of' | 'self';
  /** Client authentication at the token endpoint (default `client_secret_basic`). */
  authMethod?: 'client_secret_basic' | 'client_secret_post';
  /** How the audience is sent: `audience` (RFC 8693, also Auth0/Keycloak), `resource` (RFC 8707) or not at all. */
  audienceParam?: 'audience' | 'resource' | 'none';
  /** Tokens are reused until this many seconds before they expire (default 30). */
  refreshSkewSec?: number;
  /** Lifetime assumed when the token endpoint sends no `expires_in` and the token is not a JWT (default 60 s). */
  defaultTtlSec?: number;
  /** Most tokens cached at once (default 1000). */
  maxCacheEntries?: number;
  timeoutMs?: number;
  allowHttp?: boolean;
  fetch?: FetchLike;
  now?: () => number;
}

interface Cached { token: string; expiresAt: number }

const formEncode = (s: string) => encodeURIComponent(s).replace(/%20/g, '+');

/**
 * OAuth 2 credentials for downstream audiences. Returns a factory: call it with the run identity to get the run's
 * `CredentialProvider`. Tokens are cached per (audience, scopes, subject token) until shortly before they expire, and
 * an on-behalf-of token never outlives the caller's own token.
 */
export function oidcCredentials(opts: OidcCredentialsOptions): CredentialFactory & { clear(): void } {
  if (!opts?.clientId || !opts.clientSecret) throw new IdentityError('identity_config', 'oidcCredentials: "clientId" and "clientSecret" are required');
  if (opts.mode !== 'on-behalf-of' && opts.mode !== 'self') throw new IdentityError('identity_config', 'oidcCredentials: "mode" must be "on-behalf-of" or "self"');
  if (!opts.tokenEndpoint && !opts.issuer) throw new IdentityError('identity_config', 'oidcCredentials: set "issuer" or "tokenEndpoint"');
  if (opts.tokenEndpoint) checkSecureUrl(opts.tokenEndpoint, 'tokenEndpoint', opts.allowHttp);
  else checkSecureUrl(opts.issuer!, 'issuer', opts.allowHttp);
  const fetchImpl: FetchLike = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const skewMs = (opts.refreshSkewSec ?? 30) * 1000;
  const maxEntries = opts.maxCacheEntries ?? 1000;
  const audienceParam = opts.audienceParam ?? 'audience';
  const cache = new Map<string, Cached>();
  const inflight = new Map<string, Promise<string>>();
  let endpoint: Promise<string> | undefined = opts.tokenEndpoint ? Promise.resolve(opts.tokenEndpoint) : undefined;

  const tokenEndpoint = () => {
    endpoint ??= discover(fetchImpl, opts.issuer!, timeoutMs, opts.allowHttp).then((doc) => {
      if (typeof doc.token_endpoint !== 'string') throw new IdentityError('identity_config', 'OIDC discovery: no "token_endpoint"');
      return checkSecureUrl(doc.token_endpoint, 'token_endpoint', opts.allowHttp).href;
    });
    endpoint.catch(() => (endpoint = undefined)); // retry discovery on the next request
    return endpoint;
  };

  const remember = (key: string, entry: Cached) => {
    if (cache.size >= maxEntries) {
      const t = now();
      for (const [k, v] of cache) if (v.expiresAt <= t) cache.delete(k);
      while (cache.size >= maxEntries) cache.delete(cache.keys().next().value!);
    }
    cache.set(key, entry);
  };

  const request = async (params: Record<string, string>, signal?: AbortSignal): Promise<{ token: string; expiresIn?: number }> => {
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    const body = new URLSearchParams(params);
    if ((opts.authMethod ?? 'client_secret_basic') === 'client_secret_basic') {
      // RFC 6749 §2.3.1: id and secret are form-encoded before base64.
      headers.authorization = `Basic ${Buffer.from(`${formEncode(opts.clientId)}:${formEncode(opts.clientSecret)}`).toString('base64')}`;
    } else {
      body.set('client_id', opts.clientId);
      body.set('client_secret', opts.clientSecret);
    }
    const what = params.grant_type === TOKEN_EXCHANGE_GRANT ? 'token exchange' : 'client credentials';
    const { body: res } = await requestJson(fetchImpl, await tokenEndpoint(), { method: 'POST', headers, body: body.toString(), signal, timeoutMs, what });
    if (typeof res?.access_token !== 'string' || !res.access_token) throw new IdentityError('identity_response', `${what}: no access_token in the response`);
    const type = typeof res.token_type === 'string' ? res.token_type.toLowerCase() : undefined;
    if (type && type !== 'bearer' && type !== 'n_a') throw new IdentityError('identity_response', `${what}: unsupported token_type "${res.token_type}"`);
    return { token: res.access_token, expiresIn: typeof res.expires_in === 'number' ? res.expires_in : undefined };
  };

  const factory = (identity?: Identity): CredentialProvider => ({
    async token(audience, topts = {}) {
      if (typeof audience !== 'string' || !audience) throw new IdentityError('identity_config', 'credentials: audience is required');
      const scopes = [...new Set(topts.scopes ?? [])].sort();
      let subjectKey = 'self';
      let subjectExp: number | undefined;
      if (opts.mode === 'on-behalf-of') {
        if (!identity?.token) throw new IdentityError('identity_missing', 'credentials: on-behalf-of needs a caller token, but the run has no identity token');
        subjectKey = `${identity.subject}:${createHash('sha256').update(identity.token).digest('base64url')}`;
        subjectExp = unverifiedExpiry(identity.token);
      }
      const key = JSON.stringify([audience, scopes, subjectKey]);
      const hit = cache.get(key);
      if (hit && hit.expiresAt > now()) return hit.token;
      if (hit) cache.delete(key);
      const pending = inflight.get(key);
      if (pending) return pending;

      const params: Record<string, string> =
        opts.mode === 'self'
          ? { grant_type: 'client_credentials' }
          : { grant_type: TOKEN_EXCHANGE_GRANT, subject_token: identity!.token!, subject_token_type: ACCESS_TOKEN_TYPE, requested_token_type: ACCESS_TOKEN_TYPE };
      if (audienceParam !== 'none') params[audienceParam] = audience;
      if (scopes.length) params.scope = scopes.join(' ');

      const promise = (async () => {
        const { token, expiresIn } = await request(params, topts.signal);
        const exp = expiresIn !== undefined ? now() + expiresIn * 1000 : (unverifiedExpiry(token) ?? now() / 1000 + (opts.defaultTtlSec ?? 60)) * 1000;
        const expiresAt = Math.min(exp, subjectExp !== undefined ? subjectExp * 1000 : Infinity) - skewMs;
        if (expiresAt > now()) remember(key, { token, expiresAt });
        return token;
      })().finally(() => inflight.delete(key));
      inflight.set(key, promise);
      return promise;
    },
  });
  return Object.assign(factory, { clear: () => cache.clear() });
}
