import type { AccessQuestion, Authorizer, CredentialProvider, Identity, IdentityVerifier } from '../types.ts';

/**
 * Conformance checks for identity and access adapters. Each returns the list of failures (empty = conformant) and
 * needs no test framework, so adapter authors can run them in any test runner or a plain script.
 */

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
const isStringArray = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string');

async function attempt<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error };
  }
}

function checkIdentityShape(id: unknown, where: string): string[] {
  const out: string[] = [];
  const v = id as Identity;
  if (!v || typeof v !== 'object') return [`${where}: not an object`];
  if (typeof v.subject !== 'string' || !v.subject) out.push(`${where}: "subject" must be a non-empty string`);
  if (v.kind !== 'user' && v.kind !== 'agent') out.push(`${where}: "kind" must be "user" or "agent"`);
  if (v.roles !== undefined && !isStringArray(v.roles)) out.push(`${where}: "roles" must be an array of strings`);
  if (v.scopes !== undefined && !isStringArray(v.scopes)) out.push(`${where}: "scopes" must be an array of strings`);
  if (v.claims !== undefined && (typeof v.claims !== 'object' || v.claims === null)) out.push(`${where}: "claims" must be an object`);
  return out;
}

/** Same token with an altered signature, and with `alg: none` and no signature. */
function forgeries(token: string): Array<[string, string]> {
  const parts = token.split('.');
  if (parts.length !== 3) return [];
  const sig = parts[2]!;
  const flipped = sig.length ? `${sig.slice(0, -2)}${sig.slice(-2, -1) === 'A' ? 'B' : 'A'}${sig.slice(-1)}` : 'AAAA';
  const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  return [
    ['tampered signature', `${parts[0]}.${parts[1]}.${flipped}`],
    ['alg none', `${none}.${parts[1]}.`],
  ];
}

export interface VerifierCases {
  /** A token the verifier must accept. */
  validToken: string;
  /** A token that has expired (beyond clock skew), which must be rejected. */
  expiredToken?: string;
  /** More tokens that must be rejected (wrong issuer, wrong audience, ...), by label. */
  invalidTokens?: Record<string, string>;
  /** Expected identity fields for `validToken`. */
  expect?: Partial<Pick<Identity, 'subject' | 'kind'>> & { roles?: string[] };
}

/** `IdentityVerifier`: accepts the valid token with a well-formed Identity; rejects garbage, forgeries and expired tokens. */
export async function checkIdentityVerifier(verifier: IdentityVerifier, cases: VerifierCases): Promise<string[]> {
  const out: string[] = [];
  if (!verifier || typeof verifier.verify !== 'function') return ['verifier has no verify() method'];
  const good = await attempt(() => verifier.verify(cases.validToken));
  if (!good.ok) out.push(`validToken rejected: ${errorMessage(good.error)}`);
  else {
    out.push(...checkIdentityShape(good.value, 'identity'));
    const e = cases.expect;
    if (e?.subject !== undefined && good.value.subject !== e.subject) out.push(`identity.subject: expected "${e.subject}", got "${good.value.subject}"`);
    if (e?.kind !== undefined && good.value.kind !== e.kind) out.push(`identity.kind: expected "${e.kind}", got "${good.value.kind}"`);
    for (const r of e?.roles ?? []) if (!good.value.roles?.includes(r)) out.push(`identity.roles: missing "${r}"`);
  }
  const rejects: Array<[string, string]> = [
    ['garbage', 'not-a-jwt'],
    ['empty', ''],
    ...forgeries(cases.validToken),
    ...(cases.expiredToken ? [['expiredToken', cases.expiredToken] as [string, string]] : []),
    ...Object.entries(cases.invalidTokens ?? {}),
  ];
  for (const [label, token] of rejects) {
    const r = await attempt(() => verifier.verify(token));
    if (r.ok) out.push(`${label}: accepted, must be rejected`);
    else if (token && token.length > 16 && errorMessage(r.error).includes(token)) out.push(`${label}: error message contains the token`);
  }
  return out;
}

export interface AuthorizerCases { allowCase: AccessQuestion; denyCase: AccessQuestion }

/** `Authorizer`: boolean decisions, allow for `allowCase`, deny for `denyCase`, string reasons, stable answers. */
export async function checkAuthorizer(authz: Authorizer, cases: AuthorizerCases): Promise<string[]> {
  const out: string[] = [];
  if (!authz || typeof authz.evaluate !== 'function') return ['authorizer has no evaluate() method'];
  for (const [label, req, expected] of [['allowCase', cases.allowCase, true], ['denyCase', cases.denyCase, false]] as const) {
    const first = await attempt(() => authz.evaluate(req));
    if (!first.ok) {
      out.push(`${label}: evaluate() failed: ${errorMessage(first.error)}`);
      continue;
    }
    const d = first.value;
    if (typeof d?.decision !== 'boolean') {
      out.push(`${label}: "decision" must be a boolean`);
      continue;
    }
    if (d.decision !== expected) out.push(`${label}: expected decision ${expected}, got ${d.decision}`);
    if (d.reason !== undefined && typeof d.reason !== 'string') out.push(`${label}: "reason" must be a string`);
    const again = await attempt(() => authz.evaluate(req));
    if (again.ok && again.value?.decision !== d.decision) out.push(`${label}: decision changed between identical requests`);
  }
  return out;
}

export interface CredentialCases {
  audience: string;
  scopes?: string[];
  /** Extra check of an issued token (e.g. verify it and inspect `aud`/`sub`); returns failures. */
  inspect?: (token: string) => string[] | Promise<string[]>;
}

/** `CredentialProvider`: a non-empty token for the audience, a token again on a second call, and an empty audience refused. */
export async function checkCredentialProvider(provider: CredentialProvider, cases: CredentialCases): Promise<string[]> {
  const out: string[] = [];
  if (!provider || typeof provider.token !== 'function') return ['provider has no token() method'];
  const first = await attempt(() => provider.token(cases.audience, { scopes: cases.scopes }));
  if (!first.ok) return [`token(${cases.audience}) failed: ${errorMessage(first.error)}`];
  if (typeof first.value !== 'string' || !first.value) return ['token() must resolve to a non-empty string'];
  if (/\s/.test(first.value)) out.push('token contains whitespace');
  const second = await attempt(() => provider.token(cases.audience, { scopes: cases.scopes }));
  if (!second.ok || typeof second.value !== 'string' || !second.value) out.push('second token() call failed');
  const empty = await attempt(() => provider.token(''));
  if (empty.ok) out.push('token("") must be rejected');
  if (cases.inspect) out.push(...(await cases.inspect(first.value)));
  return out;
}
