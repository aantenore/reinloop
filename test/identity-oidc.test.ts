import assert from 'node:assert/strict';
import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import {
  accessRequest, authorizeCall, authzenAuthorizer, checkAuthorizer, checkCredentialProvider, checkIdentityVerifier, collectSink, createRegistry,
  createRuntime, decide, defineTool, mcpTools, memoryStore, oidcCredentials, oidcVerifier, opaAuthorizer, run, serve,
  type AccessRequest, type Authorizer, type HarnessConfig, type Identity, type RunEvent, type Tool, type ToolCallPart,
} from '../src/index.ts';
import { makeAgent } from './helpers.ts';

// ---- a mock OpenID provider ----------------------------------------------------------------------------------------

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;

async function listen(handler: Handler): Promise<{ server: Server; url: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => handler(req, body, res));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, url, close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))) };
}

const sendJson = (res: ServerResponse, body: unknown, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

interface SigningKey { kid: string; alg: 'RS256' | 'ES256'; privateKey: KeyObject; jwk: Record<string, unknown> }

function makeKey(kid: string, alg: 'RS256' | 'ES256' = 'RS256'): SigningKey {
  const pair = alg === 'RS256' ? generateKeyPairSync('rsa', { modulusLength: 2048 }) : generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { kid, alg, privateKey: pair.privateKey, jwk: { ...pair.publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg } };
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

function signJwt(key: SigningKey, claims: Record<string, unknown>, header: Record<string, unknown> = {}): string {
  const input = `${b64({ alg: key.alg, typ: 'JWT', kid: key.kid, ...header })}.${b64(claims)}`;
  const sig = key.alg === 'RS256'
    ? sign('sha256', Buffer.from(input), key.privateKey)
    : sign('sha256', Buffer.from(input), { key: key.privateKey, dsaEncoding: 'ieee-p1363' });
  return `${input}.${sig.toString('base64url')}`;
}

const now = () => Math.floor(Date.now() / 1000);

class MockIdp {
  keys: SigningKey[] = [];
  jwksHits = 0;
  discoveryHits = 0;
  tokenRequests: Array<{ params: URLSearchParams; authorization?: string }> = [];
  tokenResponse: (params: URLSearchParams) => { status?: number; body: unknown } = () => ({ body: { access_token: 'opaque', token_type: 'Bearer', expires_in: 300 } });
  issuerOverride?: string;
  url = '';
  issuer = '';
  private srv?: Awaited<ReturnType<typeof listen>>;

  async start() {
    this.srv = await listen((req, body, res) => {
      if (req.url === '/realms/test/.well-known/openid-configuration') {
        this.discoveryHits++;
        return sendJson(res, { issuer: this.issuerOverride ?? this.issuer, jwks_uri: `${this.issuer}/certs`, token_endpoint: `${this.issuer}/token` });
      }
      if (req.url === '/realms/test/certs') {
        this.jwksHits++;
        return sendJson(res, { keys: this.keys.map((k) => k.jwk) });
      }
      if (req.url === '/realms/test/token' && req.method === 'POST') {
        const params = new URLSearchParams(body);
        this.tokenRequests.push({ params, authorization: req.headers.authorization });
        const out = this.tokenResponse(params);
        return sendJson(res, out.body, out.status ?? 200);
      }
      sendJson(res, { error: 'not_found' }, 404);
    });
    this.url = this.srv.url;
    this.issuer = `${this.url}/realms/test`;
  }

  token(claims: Record<string, unknown> = {}, key = this.keys[0]!, header: Record<string, unknown> = {}) {
    return signJwt(key, { iss: this.issuer, aud: 'tools-api', sub: 'alice-id', exp: now() + 300, iat: now(), ...claims }, header);
  }

  close() {
    return this.srv?.close();
  }
}

// ---- verifier ------------------------------------------------------------------------------------------------------

describe('oidcVerifier', () => {
  const idp = new MockIdp();
  before(async () => {
    await idp.start();
    idp.keys = [makeKey('k1'), makeKey('e1', 'ES256')];
  });
  after(() => idp.close());

  it('verifies RS256 and ES256 tokens via discovery and maps claims to an Identity', async () => {
    const v = oidcVerifier({ issuer: idp.issuer, audience: 'tools-api' });
    const token = idp.token({
      realm_access: { roles: ['analyst', 'offline_access'] },
      resource_access: { 'tools-api': { roles: ['writer'] }, other: { roles: ['x'] } },
      roles: ['extra'],
      scope: 'openid profile tools.read',
      preferred_username: 'alice',
    });
    const id = await v.verify(token);
    assert.equal(id.subject, 'alice-id');
    assert.equal(id.kind, 'user');
    assert.deepEqual(id.roles, ['analyst', 'offline_access', 'extra', 'tools-api:writer'], 'client roles of the audience only, namespaced');
    assert.deepEqual(id.scopes, ['openid', 'profile', 'tools.read']);
    assert.equal(id.claims?.preferred_username, 'alice');
    assert.equal(id.token, token);
    const ec = await v.verify(idp.token({}, idp.keys[1]));
    assert.equal(ec.subject, 'alice-id');
    const noAudience = await oidcVerifier({ issuer: idp.issuer }).verify(token);
    assert.deepEqual(noAudience.roles, ['analyst', 'offline_access', 'extra'], 'without audience or roleClients no client is read');
    const flat = await oidcVerifier({ issuer: idp.issuer, roleClients: ['other'], namespaceClientRoles: false }).verify(token);
    assert.deepEqual(flat.roles, ['analyst', 'offline_access', 'extra', 'x']);
  });

  it('rejects bad signatures, wrong iss/aud, expired, not-yet-valid, future iat and missing exp', async () => {
    const v = oidcVerifier({ issuer: idp.issuer, audience: ['tools-api'], clockSkewSec: 5 });
    const good = idp.token();
    const [h, p, s] = good.split('.');
    const otherKey = makeKey('k1'); // same kid, different key
    const cases: Array<[string, string, RegExp]> = [
      ['bad signature', `${h}.${p}.${s!.slice(0, -4)}AAAA`, /signature/],
      ['foreign key', idp.token({}, otherKey), /signature/],
      ['payload swap', `${h}.${b64({ ...JSON.parse(Buffer.from(p!, 'base64url').toString()), sub: 'mallory' })}.${s}`, /signature/],
      ['wrong issuer', idp.token({ iss: 'https://evil.example/realms/test' }), /issuer/],
      ['wrong audience', idp.token({ aud: 'account' }), /audience/],
      ['expired', idp.token({ exp: now() - 60 }), /expired/],
      ['not yet valid', idp.token({ nbf: now() + 120 }), /not yet valid/],
      ['iat in future', idp.token({ iat: now() + 120 }), /iat/],
      ['no exp', idp.token({ exp: undefined }), /exp/],
      ['crit header', idp.token({}, idp.keys[0], { crit: ['b64'] }), /critical/],
      ['malformed', 'abc.def', /malformed/],
    ];
    for (const [label, token, re] of cases) await assert.rejects(v.verify(token), re, label);
    // Tolerance: expired 3 s ago with 5 s skew is still accepted.
    await v.verify(idp.token({ exp: now() - 3 }));
  });

  it('refuses alg none, HS256 and algorithms outside the allow-list', async () => {
    const v = oidcVerifier({ issuer: idp.issuer });
    const payload = b64({ iss: idp.issuer, sub: 'x', exp: now() + 60 });
    await assert.rejects(v.verify(`${b64({ alg: 'none' })}.${payload}.`), /not accepted/);
    await assert.rejects(v.verify(`${b64({ alg: 'HS256', kid: 'k1' })}.${payload}.c2ln`), /not accepted/);
    await assert.rejects(v.verify(`${b64({ alg: 'PS256', kid: 'k1' })}.${payload}.c2ln`), /not allowed/);
    assert.throws(() => oidcVerifier({ issuer: idp.issuer, algorithms: ['HS256'] }), /not accepted/);
    assert.throws(() => oidcVerifier({ issuer: idp.issuer, algorithms: ['none'] }), /not accepted/);
    // An RS256 header pointing at an EC key never verifies (key type is bound to the algorithm).
    const ecAsRs = signJwt({ ...idp.keys[1]!, alg: 'ES256' }, { iss: idp.issuer, sub: 'x', exp: now() + 60 }, { alg: 'RS256' });
    await assert.rejects(v.verify(ecAsRs), /no signing key|signature/);
  });

  it('refetches the JWKS for an unknown kid (rotation), rate limited', async () => {
    let clock = Date.now();
    const v = oidcVerifier({ issuer: idp.issuer, jwksMinRefreshMs: 30_000, now: () => clock });
    await v.verify(idp.token());
    const base = idp.jwksHits;
    const rotated = makeKey('k2');
    idp.keys.push(rotated);
    await assert.rejects(v.verify(idp.token({}, rotated)), /no signing key/, 'cooldown right after the first fetch');
    assert.equal(idp.jwksHits, base);
    clock += 31_000;
    await v.verify(idp.token({}, rotated));
    assert.equal(idp.jwksHits, base + 1, 'one refetch for the new kid');
    await assert.rejects(v.verify(idp.token({}, makeKey('k3'))), /no signing key/);
    await assert.rejects(v.verify(idp.token({}, makeKey('k4'))), /no signing key/);
    assert.equal(idp.jwksHits, base + 1, 'unknown kids within the interval do not refetch');
    clock += 31_000;
    const k5 = makeKey('k5');
    idp.keys.push(k5);
    await v.verify(idp.token({}, k5));
    assert.equal(idp.jwksHits, base + 2);
  });

  it('checks the discovered issuer and refuses plain http beyond loopback', async () => {
    idp.issuerOverride = 'https://other.example';
    try {
      await assert.rejects(oidcVerifier({ issuer: idp.issuer }).verify(idp.token()), /issuer mismatch/);
    } finally {
      idp.issuerOverride = undefined;
    }
    assert.throws(() => oidcVerifier({ issuer: 'http://idp.example.com/realms/x' }), /https/);
    assert.doesNotThrow(() => oidcVerifier({ issuer: 'http://idp.example.com/realms/x', allowHttp: true }));
  });

  it('client roles cannot pose as realm roles', async () => {
    const token = idp.token({ realm_access: { roles: ['viewer'] }, resource_access: { 'tools-api': { roles: ['admin'] }, evil: { roles: ['admin'] } } });
    assert.deepEqual((await oidcVerifier({ issuer: idp.issuer, audience: 'tools-api' }).verify(token)).roles, ['viewer', 'tools-api:admin']);
    assert.deepEqual((await oidcVerifier({ issuer: idp.issuer, audience: 'tools-api', roleClients: [] }).verify(token)).roles, ['viewer']);
    assert.deepEqual((await oidcVerifier({ issuer: idp.issuer, roleClients: ['constructor', 'toString'] }).verify(token)).roles, ['viewer']);
  });

  it('derives kind agent only for allow-listed clients with a client-credentials subject', async () => {
    const sa = { sub: 'sa-uuid', azp: 'agent-runtime', client_id: 'agent-runtime', preferred_username: 'service-account-agent-runtime' };
    assert.equal((await oidcVerifier({ issuer: idp.issuer }).verify(idp.token(sa))).kind, 'user', 'no allow-list: never agent');
    assert.equal((await oidcVerifier({ issuer: idp.issuer, agentClients: ['agent-runtime'] }).verify(idp.token(sa))).kind, 'user', 'sub is not the client');
    const v = oidcVerifier({ issuer: idp.issuer, agentClients: ['agent-runtime'], agentSubjects: { 'agent-runtime': 'sa-uuid' } });
    const kc = await v.verify(idp.token(sa));
    assert.deepEqual([kc.kind, kc.subject], ['agent', 'sa-uuid']);
    const rfc9068 = await oidcVerifier({ issuer: idp.issuer, agentClients: ['agent-runtime'] }).verify(idp.token({ sub: 'agent-runtime', client_id: 'agent-runtime' }));
    assert.equal(rfc9068.kind, 'agent');
    const noSub = await v.verify(idp.token({ sub: undefined, azp: 'agent-runtime' }));
    assert.deepEqual([noSub.kind, noSub.subject], ['agent', 'agent-runtime']);
    const exchanged = await v.verify(idp.token({ sub: 'alice-id', azp: 'agent-runtime' }));
    assert.equal(exchanged.kind, 'user');
    const spoof = await oidcVerifier({ issuer: idp.issuer, agentClients: ['agent-runtime'] }).verify(idp.token({ sub: 'mallory', azp: 'agent-runtime', preferred_username: 'service-account-agent-runtime' }));
    assert.equal(spoof.kind, 'user', 'usernames never make an agent');
    assert.equal((await v.verify(idp.token({ sub: 'agent-runtime', azp: 'agent-runtime', client_id: 'other' }))).kind, 'user', 'azp and client_id disagree');
    await assert.rejects(oidcVerifier({ issuer: idp.issuer }).verify(idp.token({ sub: undefined, azp: 'agent-runtime' })), /no subject/);
    await assert.rejects(v.verify(idp.token({ sub: undefined, azp: 'web' })), /no subject/);
    await assert.rejects(v.verify(idp.token({ sub: '' })), /no subject/);
    const custom = await oidcVerifier({ issuer: idp.issuer, kind: () => 'agent' }).verify(idp.token());
    assert.equal(custom.kind, 'agent');
  });

  it('passes the conformance check, and so does a forged/expired token set', async () => {
    const failures = await checkIdentityVerifier(oidcVerifier({ issuer: idp.issuer, audience: 'tools-api' }), {
      validToken: idp.token({ realm_access: { roles: ['analyst'] } }),
      expiredToken: idp.token({ exp: now() - 3600 }),
      invalidTokens: { 'wrong audience': idp.token({ aud: 'x' }) },
      expect: { subject: 'alice-id', kind: 'user', roles: ['analyst'] },
    });
    assert.deepEqual(failures, []);
    const lax = { verify: async () => ({ subject: 'x', kind: 'user' as const }) };
    const bad = await checkIdentityVerifier(lax, { validToken: idp.token() });
    assert.ok(bad.some((f) => f.startsWith('alg none')));
  });
});

// ---- credentials ---------------------------------------------------------------------------------------------------

describe('oidcCredentials', () => {
  const idp = new MockIdp();
  before(async () => {
    await idp.start();
    idp.keys = [makeKey('k1')];
  });
  after(() => idp.close());

  const userToken = () => idp.token({ sub: 'alice-id', exp: now() + 600 });
  const alice = (token = userToken()): Identity => ({ subject: 'alice-id', kind: 'user', token });

  it('on-behalf-of sends an RFC 8693 token exchange with client_secret_basic', async () => {
    idp.tokenRequests = [];
    idp.tokenResponse = () => ({ body: { access_token: 'exchanged-1', token_type: 'Bearer', expires_in: 300, issued_token_type: 'urn:ietf:params:oauth:token-type:access_token' } });
    const factory = oidcCredentials({ issuer: idp.issuer, clientId: 'agent-runtime', clientSecret: 's3cr:t', mode: 'on-behalf-of' });
    const id = alice();
    assert.equal(await factory(id).token('tools-api', { scopes: ['b', 'a'] }), 'exchanged-1');
    const req = idp.tokenRequests[0]!;
    assert.equal(req.params.get('grant_type'), 'urn:ietf:params:oauth:grant-type:token-exchange');
    assert.equal(req.params.get('subject_token'), id.token);
    assert.equal(req.params.get('subject_token_type'), 'urn:ietf:params:oauth:token-type:access_token');
    assert.equal(req.params.get('requested_token_type'), 'urn:ietf:params:oauth:token-type:access_token');
    assert.equal(req.params.get('audience'), 'tools-api');
    assert.equal(req.params.get('scope'), 'a b');
    assert.equal(req.params.get('client_secret'), null);
    assert.equal(req.authorization, `Basic ${Buffer.from('agent-runtime:s3cr%3At').toString('base64')}`);
  });

  it('self uses client_credentials (client_secret_post) and caches per audience and scopes', async () => {
    idp.tokenRequests = [];
    let n = 0;
    idp.tokenResponse = () => ({ body: { access_token: `cc-${++n}`, token_type: 'bearer', expires_in: 300 } });
    const creds = oidcCredentials({ tokenEndpoint: `${idp.issuer}/token`, clientId: 'agent-runtime', clientSecret: 'x', mode: 'self', authMethod: 'client_secret_post' })();
    assert.equal(await creds.token('tools-api'), 'cc-1');
    assert.equal(await creds.token('tools-api'), 'cc-1');
    assert.equal(await creds.token('tools-api', { scopes: ['read'] }), 'cc-2');
    assert.equal(await creds.token('other-api'), 'cc-3');
    const [first] = idp.tokenRequests;
    assert.equal(first!.params.get('grant_type'), 'client_credentials');
    assert.equal(first!.params.get('client_id'), 'agent-runtime');
    assert.equal(first!.params.get('client_secret'), 'x');
    assert.equal(first!.authorization, undefined);
    assert.equal(idp.tokenRequests.length, 3);
    // Concurrent requests share one round trip.
    const [a, b] = await Promise.all([creds.token('third'), creds.token('third')]);
    assert.equal(a, b);
    assert.equal(idp.tokenRequests.length, 4);
    assert.deepEqual(await checkCredentialProvider(creds, { audience: 'tools-api' }), []);
  });

  it('refreshes before expiry, keys the cache by subject token and caps it at the caller token exp', async () => {
    let clock = Date.now();
    let n = 0;
    idp.tokenRequests = [];
    idp.tokenResponse = () => ({ body: { access_token: `t-${++n}`, expires_in: 120 } });
    const factory = oidcCredentials({ issuer: idp.issuer, clientId: 'c', clientSecret: 's', mode: 'on-behalf-of', now: () => clock });
    const id = alice(idp.token({ sub: 'alice-id', exp: Math.floor(clock / 1000) + 600 }));
    assert.equal(await factory(id).token('tools-api'), 't-1');
    assert.equal(await factory(id).token('tools-api'), 't-1', 'reused across runs of the same caller token');
    clock += 91_000; // 120 s lifetime - 30 s skew
    assert.equal(await factory(id).token('tools-api'), 't-2');
    const otherToken = alice(idp.token({ sub: 'alice-id', exp: Math.floor(clock / 1000) + 600, jti: 'other' }));
    assert.equal(await factory(otherToken).token('tools-api'), 't-3', 'another caller token is another cache entry');
    const shortLived = alice(idp.token({ sub: 'alice-id', exp: Math.floor(clock / 1000) + 20, jti: 'short' }));
    assert.equal(await factory(shortLived).token('tools-api'), 't-4');
    assert.equal(await factory(shortLived).token('tools-api'), 't-5', 'never cached past the caller token');
  });

  it('fails clearly without a caller token, and on token endpoint errors without leaking secrets', async () => {
    const factory = oidcCredentials({ issuer: idp.issuer, clientId: 'c', clientSecret: 'very-secret', mode: 'on-behalf-of' });
    await assert.rejects(factory(undefined).token('tools-api'), /no identity token/);
    await assert.rejects(factory({ subject: 'x', kind: 'user' }).token('tools-api'), /no identity token/);
    idp.tokenResponse = () => ({ status: 400, body: { error: 'invalid_request', error_description: 'subject_token is invalid' } });
    const subject = userToken();
    const err = await factory(alice(subject)).token('tools-api').catch((e: Error) => e);
    assert.match(String(err), /HTTP 400 \(invalid_request: subject_token is invalid\)/);
    assert.ok(!String(err).includes('very-secret') && !String(err).includes(subject));
    idp.tokenResponse = () => ({ body: { access_token: 'x', token_type: 'mac' } });
    await assert.rejects(factory(alice()).token('tools-api'), /unsupported token_type/);
  });
});

// ---- policy `when` and the PDP -------------------------------------------------------------------------------------

const call = (name: string, args: unknown = {}): ToolCallPart => ({ type: 'tool_call', id: 'c1', name, args });
const tool = (name: string, risk: 'read' | 'write' | 'exec'): Tool => defineTool({ name, description: name, risk, schema: { type: 'object' }, run: () => `${name} ok` });
const analyst: Identity = { subject: 'alice', kind: 'user', roles: ['analyst'], scopes: ['tools.write'], token: 'tok-alice-SECRET' };
const viewer: Identity = { subject: 'bob', kind: 'user', roles: ['viewer'], scopes: [], token: 'tok-bob-SECRET' };

describe('policy when', () => {
  const policy = {
    rules: [
      { match: 'shell', when: { kind: 'agent' as const }, action: 'deny' as const, reason: 'agents never exec' },
      { risk: 'write' as const, when: { roles: ['analyst', 'admin'] }, action: 'allow' as const },
      { match: 'scoped', when: { scopes: ['tools.write'] }, action: 'allow' as const },
      { risk: 'write' as const, action: 'deny' as const },
    ],
  };
  it('matches roles and scopes any-of, kind exactly, and never without identity', () => {
    assert.equal(decide(policy, call('edit'), tool('edit', 'write'), analyst).decision, 'allow');
    assert.equal(decide(policy, call('edit'), tool('edit', 'write'), viewer).decision, 'deny');
    assert.equal(decide(policy, call('edit'), tool('edit', 'write')).decision, 'deny');
    assert.equal(decide(policy, call('scoped'), tool('scoped', 'exec'), { ...viewer, scopes: ['tools.write'] }).decision, 'allow');
    assert.equal(decide(policy, call('shell'), tool('shell', 'exec'), { subject: 'a', kind: 'agent' }).decision, 'deny');
    assert.equal(decide(policy, call('shell'), tool('shell', 'exec'), analyst).decision, 'ask');
  });
});

function recordingAuthorizer(answer: (req: AccessRequest) => boolean | Error): Authorizer & { requests: AccessRequest[] } {
  const requests: AccessRequest[] = [];
  return {
    requests,
    async evaluate(req) {
      requests.push(req);
      const out = answer(req);
      if (out instanceof Error) throw out;
      return { decision: out, ...(!out && { reason: `${req.subject.id} may not ${req.resource.id}` }) };
    },
  };
}

describe('pdp', () => {
  const agent = 'helper';
  it('local deny wins without asking the PDP; PDP deny and errors deny; allow keeps ask', async () => {
    const pdp = recordingAuthorizer((r) => r.subject.id === 'alice');
    const policy = { rules: [{ match: 'rm', action: 'deny' as const }], risk: { write: 'allow' as const }, pdp: { authorizer: pdp } };
    const denied = await authorizeCall(policy, call('rm'), tool('rm', 'write'), { agent, identity: analyst });
    assert.equal(denied.decision, 'deny');
    assert.equal(pdp.requests.length, 0);
    assert.equal((await authorizeCall(policy, call('edit'), tool('edit', 'write'), { agent, identity: analyst })).decision, 'allow');
    const bob = await authorizeCall(policy, call('edit'), tool('edit', 'write'), { agent, identity: viewer });
    assert.deepEqual(bob, { decision: 'deny', reason: 'pdp: bob may not edit' });
    const ask = await authorizeCall(policy, call('sh'), tool('sh', 'exec'), { agent, identity: analyst });
    assert.equal(ask.decision, 'ask');
    const failing = { ...policy, pdp: { authorizer: recordingAuthorizer(() => new Error('connection refused')) } };
    const err = await authorizeCall(failing, call('edit'), tool('edit', 'write'), { agent, identity: analyst });
    assert.equal(err.decision, 'deny');
    assert.match(err.reason, /^pdp error \(deny\): connection refused/);
    assert.equal((await authorizeCall({ ...failing, pdp: { ...failing.pdp, onError: 'allow' } }, call('edit'), tool('edit', 'write'), { agent, identity: analyst })).decision, 'allow');
    assert.equal((await authorizeCall({ ...failing, pdp: { ...failing.pdp, onError: 'ask' } }, call('edit'), tool('edit', 'write'), { agent, identity: analyst })).decision, 'ask');
    const unresolved = await authorizeCall({ pdp: { type: 'opa' } }, call('edit'), tool('edit', 'read'), { agent });
    assert.equal(unresolved.decision, 'deny');
  });

  it('builds AuthZEN-shaped requests, with args only on opt-in', () => {
    const req = accessRequest(call('edit', { path: '/etc/x' }), { ...tool('edit', 'write'), layer: 'tool' }, agent, analyst);
    assert.deepEqual(req, {
      subject: { type: 'user', id: 'alice', properties: { roles: ['analyst'], scopes: ['tools.write'], authenticated: true } },
      action: { name: 'call' },
      resource: { type: 'tool', id: 'edit', properties: { risk: 'write', agent, layer: 'tool' } },
    });
    assert.deepEqual(accessRequest(call('edit', { a: 1 }), tool('edit', 'write'), agent, analyst, true).context, { args: { a: 1 } });
    assert.deepEqual(accessRequest(call('x'), tool('x', 'read'), agent, undefined).subject, { type: 'agent', id: 'agent:helper', properties: { roles: [], scopes: [], authenticated: false } });
    assert.ok(!JSON.stringify(req).includes('SECRET'));
  });

  it('denies through a run, puts the reason on tool_decision and never a token in events or the store', async () => {
    const pdp = recordingAuthorizer((r) => r.subject.properties?.roles instanceof Array && (r.subject.properties.roles as string[]).includes('analyst'));
    const write = tool('save', 'write');
    const store = memoryStore();
    const sink = collectSink();
    const exchanged = 'downstream-token-SECRET';
    const seen: string[] = [];
    const probe = defineTool({ name: 'probe', description: 'p', risk: 'read', schema: { type: 'object' }, run: async (_a, ctx) => (seen.push(await ctx.credentials!.token('tools-api')), 'ok') });
    const agentDef = makeAgent([{ toolCalls: [{ name: 'save', args: { v: 1 } }, { name: 'probe', args: {} }] }, { text: 'done' }], {
      name: agent,
      tools: [write, probe],
      policy: { risk: { write: 'allow' }, pdp: { authorizer: pdp } },
    });
    const res = await run(agentDef, 'go', { identity: viewer, credentials: { token: async () => exchanged }, store, sinks: [sink] });
    assert.equal(res.status, 'completed');
    const decisions = sink.events.filter((e) => e.type === 'tool_decision') as RunEvent<'tool_decision'>[];
    assert.deepEqual(decisions.map((d) => [d.data.name, d.data.allowed]), [['save', false], ['probe', false]]);
    assert.equal(decisions[0]!.data.reason, 'pdp: bob may not save');
    assert.equal(pdp.requests[0]!.context, undefined);
    const all = JSON.stringify(sink.events) + JSON.stringify(await store.load(res.runId));
    for (const secret of [viewer.token!, exchanged]) assert.ok(!all.includes(secret), 'no token in events');
    assert.deepEqual(seen, []);
  });
});

describe('opa and authzen adapters', () => {
  let srv: Awaited<ReturnType<typeof listen>>;
  const hits: Array<{ url: string; body: any; headers: IncomingMessage['headers'] }> = [];
  let opaResult: unknown = true;
  before(async () => {
    srv = await listen((req, body, res) => {
      hits.push({ url: req.url!, body: JSON.parse(body || '{}'), headers: req.headers });
      if (req.url === '/v1/data/agents/allow') return sendJson(res, opaResult === undefined ? {} : { result: opaResult });
      if (req.url === '/access/v1/evaluation') {
        const allow = JSON.parse(body).subject.id === 'alice';
        return sendJson(res, { decision: allow, ...(!allow && { context: { reason_admin: { en: 'viewer role' } } }) });
      }
      if (req.url === '/broken/access/v1/evaluation') return sendJson(res, { decision: 'yes' });
      sendJson(res, { error: 'nope' }, 500);
    });
  });
  after(() => srv.close());
  const req = (id: string): AccessRequest => accessRequest(call('save'), tool('save', 'write'), 'a', { subject: id, kind: 'user', roles: [] });

  it('opa posts {input} to /v1/data/<path> and reads boolean or {allow, reason}', async () => {
    const opa = opaAuthorizer({ url: srv.url, headers: { authorization: 'Bearer pdp-key' } });
    opaResult = true;
    assert.deepEqual(await opa.evaluate(req('alice')), { decision: true });
    assert.deepEqual(hits.at(-1)!.body, { input: req('alice') });
    assert.equal(hits.at(-1)!.headers.authorization, 'Bearer pdp-key');
    opaResult = { allow: false, reason: 'viewers read only' };
    assert.deepEqual(await opa.evaluate(req('bob')), { decision: false, reason: 'viewers read only' });
    opaResult = undefined;
    await assert.rejects(opa.evaluate(req('bob')), /no boolean decision at data\.agents\.allow/);
    await assert.rejects(opaAuthorizer({ url: srv.url, path: 'other/rule' }).evaluate(req('bob')), /HTTP 500/);
    assert.throws(() => opaAuthorizer({ url: srv.url, path: '../x' }), /must look like/);
    opaResult = { allow: true };
  });

  it('authzen posts to /access/v1/evaluation and reads decision and context reason', async () => {
    const az = authzenAuthorizer({ url: `${srv.url}/` });
    assert.deepEqual(await az.evaluate(req('alice')), { decision: true });
    assert.deepEqual(await az.evaluate(req('bob')), { decision: false, reason: '{"en":"viewer role"}' });
    await assert.rejects(authzenAuthorizer({ url: `${srv.url}/broken` }).evaluate(req('x')), /boolean "decision"/);
    assert.deepEqual(await checkAuthorizer(az, { allowCase: req('alice'), denyCase: req('bob') }), []);
    const wrong = await checkAuthorizer(az, { allowCase: req('bob'), denyCase: req('alice') });
    assert.equal(wrong.length, 2);
  });
});

// ---- serve, MCP auth and config wiring -----------------------------------------------------------------------------

describe('serve with identity', () => {
  const idp = new MockIdp();
  before(async () => {
    await idp.start();
    idp.keys = [makeKey('k1')];
  });
  after(() => idp.close());

  const config = (): HarnessConfig => ({
    providers: { mock: { type: 'mock', responses: [{ text: 'hello' }], loop: true } },
    models: { m: { provider: 'mock', model: 'mock-1' } },
    agents: { echo: { model: 'm', description: 'Echo' } },
  });

  it('401 without or with a bad token, runs as the verified identity, keeps the static token, isolates runs', async () => {
    const rt = await createRuntime({ ...config(), identity: { verifier: { issuer: idp.issuer, audience: 'tools-api' } } });
    const served = await serve(rt, { port: 0, token: 'operator-key' });
    const post = (headers: Record<string, string>, body: unknown = { input: 'hi' }) =>
      fetch(`${served.url}/v1/agents/echo/runs`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    try {
      const none = await post({});
      assert.equal(none.status, 401);
      assert.match(none.headers.get('www-authenticate')!, /^Bearer realm="reinloop"/);
      const expired = await post({ authorization: `Bearer ${idp.token({ exp: now() - 3600 })}` });
      assert.equal(expired.status, 401);
      assert.match(expired.headers.get('www-authenticate')!, /error="invalid_token", error_description="token expired"/);
      assert.equal((await post({ authorization: 'Basic abc' })).status, 401);

      const aliceToken = idp.token({ sub: 'alice-id' });
      const ok = await post({ authorization: `Bearer ${aliceToken}` });
      assert.equal(ok.status, 200);
      const result = await ok.json();
      const events = (await rt.store.load(result.runId)) as RunEvent[];
      const start = events.find((e) => e.type === 'run_start') as RunEvent<'run_start'>;
      assert.deepEqual([start.data.subject, start.data.identityKind], ['alice-id', 'user']);
      assert.ok(!JSON.stringify(events).includes(aliceToken));

      const bobToken = idp.token({ sub: 'bob-id' });
      assert.equal((await fetch(`${served.url}/v1/runs/${result.runId}`, { headers: { authorization: `Bearer ${bobToken}` } })).status, 404);
      assert.equal((await post({ authorization: `Bearer ${bobToken}` }, { input: 'x', runId: result.runId })).status, 404);
      assert.equal((await fetch(`${served.url}/v1/runs/${result.runId}`, { headers: { authorization: `Bearer ${aliceToken}` } })).status, 200);
      assert.equal((await fetch(`${served.url}/v1/runs`, { headers: { authorization: `Bearer ${aliceToken}` } })).status, 403);
      assert.equal((await fetch(`${served.url}/v1/runs`, { headers: { authorization: 'Bearer operator-key' } })).status, 200);
      assert.equal((await post({ authorization: 'Bearer operator-key' })).status, 200);
    } finally {
      await served.close();
      await rt.close();
    }
  });

  it('optional identity: anonymous calls pass, invalid tokens still fail; 503 when the IdP is down', async () => {
    const rt = await createRuntime({ ...config(), identity: { verifier: { issuer: idp.issuer }, required: false } });
    const served = await serve(rt, { port: 0 });
    try {
      assert.equal((await fetch(`${served.url}/v1/agents`)).status, 200);
      assert.equal((await fetch(`${served.url}/v1/agents`, { headers: { authorization: 'Bearer junk' } })).status, 401);
    } finally {
      await served.close();
      await rt.close();
    }
    const down = await createRuntime({ ...config(), identity: { verifier: { issuer: 'http://127.0.0.1:9/realms/x', timeoutMs: 500 } } });
    const s2 = await serve(down, { port: 0 });
    try {
      assert.equal((await fetch(`${s2.url}/v1/agents`, { headers: { authorization: `Bearer ${idp.token()}` } })).status, 503);
    } finally {
      await s2.close();
      await down.close();
    }
  });
});

describe('mcp auth and config wiring', () => {
  let mcp: Awaited<ReturnType<typeof listen>>;
  const auths: Array<{ method: string; authorization?: string }> = [];
  before(async () => {
    mcp = await listen((req, body, res) => {
      const msg = JSON.parse(body || '{}');
      auths.push({ method: msg.method, authorization: req.headers.authorization });
      if (msg.id === undefined) return void res.writeHead(202).end();
      const result =
        msg.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'mock' } }
        : msg.method === 'tools/list' ? { tools: [{ name: 'save', inputSchema: { type: 'object' }, annotations: { destructiveHint: false } }] }
        : { content: [{ type: 'text', text: `saved by ${req.headers.authorization}` }] };
      sendJson(res, { jsonrpc: '2.0', id: msg.id, result });
    });
  });
  after(() => mcp.close());

  it('sends the run credentials as bearer per call and refuses calls without credentials', async () => {
    auths.length = 0;
    const connect = { token: async (aud: string) => `connect-${aud}` };
    const { client, tools } = await mcpTools('api', { url: mcp.url, headers: { Authorization: 'Bearer static' }, auth: { audience: 'tools-api' } }, { credentials: connect });
    try {
      assert.equal(auths[0]!.authorization, 'Bearer connect-tools-api');
      const agentDef = makeAgent([{ toolCalls: [{ name: 'api__save', args: {} }] }, { text: 'done' }], { tools, policy: { risk: { write: 'allow' } } });
      const sink = collectSink();
      const res = await run(agentDef, 'go', { identity: analyst, credentials: { token: async (aud) => `obo-${aud}-SECRET` }, sinks: [sink] });
      assert.equal(res.status, 'completed');
      const callAuth = auths.find((a) => a.method === 'tools/call')!;
      assert.equal(callAuth.authorization, 'Bearer obo-tools-api-SECRET');
      const result = sink.events.find((e) => e.type === 'tool_result') as RunEvent<'tool_result'>;
      assert.match(result.data.content, /saved by Bearer \[redacted\]/); // the mock echoes it; real servers should not, and the token is masked anyway
      assert.doesNotMatch(result.data.content, /obo-tools-api-SECRET/);
      const anon = await run(makeAgent([{ toolCalls: [{ name: 'api__save', args: {} }] }, { text: 'done' }], { tools, policy: { risk: { write: 'allow' } } }), 'go');
      assert.match(JSON.stringify(anon.messages), /requires credentials for audience \\"tools-api\\"/);
    } finally {
      await client.close();
    }
    await assert.rejects(mcpTools('x', { command: 'true', auth: { audience: 'a' } }), /needs the streamable HTTP transport/);
  });

  it('masks the per-call token and static header secrets in text and in structured content', async () => {
    const echo = await listen((req, body, res) => {
      const msg = JSON.parse(body || '{}');
      if (msg.id === undefined) return void res.writeHead(202).end();
      const result =
        msg.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'mock' } }
        : msg.method === 'tools/list' ? { tools: [{ name: 'dump', inputSchema: { type: 'object' } }] }
        : { content: [], structuredContent: { authorization: req.headers.authorization, apiKey: req.headers['x-api-key'] } };
      sendJson(res, { jsonrpc: '2.0', id: msg.id, result });
    });
    const { client, tools } = await mcpTools('api', { url: echo.url, headers: { 'x-api-key': 'key-from-env-123' }, auth: { audience: 'a' } });
    try {
      const out: any = await tools[0]!.run({}, { signal: new AbortController().signal, credentials: { token: async () => 'tok-xyz-789' } } as any);
      for (const secret of ['tok-xyz-789', 'key-from-env-123']) assert.equal(out.content.includes(secret), false, secret);
      assert.deepEqual(JSON.parse(out.content), { authorization: 'Bearer [redacted]', apiKey: '[redacted]' });
    } finally {
      await client.close();
      await echo.close();
    }
  });

  it('masks the token and static header secrets in errors thrown by the transport and by the server', async () => {
    let mode = 'http';
    const echo = await listen((req, body, res) => {
      const msg = JSON.parse(body || '{}');
      if (msg.id === undefined) return void res.writeHead(202).end();
      const secrets = `${req.headers.authorization} ${req.headers['x-api-key']}`;
      // The credentials start 287 characters in, so the 300-character cut falls inside them.
      if (msg.method === 'tools/call' && mode === 'long') return void res.writeHead(500, { 'content-type': 'text/plain' }).end(`${'y'.repeat(287)}${secrets}`);
      if (msg.method === 'tools/call' && mode === 'http') return void res.writeHead(500, { 'content-type': 'text/plain' }).end(`upstream failed for ${secrets}`);
      if (msg.method === 'tools/call') return void sendJson(res, { jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: `rejected ${secrets}` } });
      const result =
        msg.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'mock' } }
        : { tools: [{ name: 'boom', inputSchema: { type: 'object' } }] };
      sendJson(res, { jsonrpc: '2.0', id: msg.id, result });
    });
    const { client, tools } = await mcpTools('api', { url: echo.url, headers: { 'x-api-key': 'key-from-env-123' }, auth: { audience: 'a' } });
    try {
      for (mode of ['http', 'rpc', 'long']) {
        await assert.rejects(
          Promise.resolve(tools[0]!.run({}, { signal: new AbortController().signal, credentials: { token: async () => 'tok-xyz-789' } } as any)),
          (err: Error) => /\[redacted\]/.test(err.message) && !/tok-|key-from/.test(`${err.message}\n${err.stack}`), // no fragment either
          mode,
        );
      }
    } finally {
      await client.close();
      await echo.close();
    }
  });

  it('builds the PDP from config through the registry and binds credentials per run', async () => {
    const registry = createRegistry();
    const pdp = recordingAuthorizer((r) => r.subject.id === 'alice');
    let factoryOptions: Record<string, unknown> | undefined;
    registry.authorizers.set('test', (o) => ((factoryOptions = o), pdp));
    const bound: Array<Identity | undefined> = [];
    registry.credentials.set('test', () => (identity?: Identity) => (bound.push(identity), { token: async () => 't' }));
    registry.tool(tool('save', 'write'));
    const rt = await createRuntime(
      {
        providers: { mock: { type: 'mock', responses: [{ toolCalls: [{ name: 'save', args: {} }] }, { text: 'done' }], loop: true } },
        models: { m: { provider: 'mock', model: 'mock-1' } },
        policy: { risk: { write: 'allow' }, pdp: { type: 'test', url: 'http://pdp', onError: 'deny', includeArgs: true } },
        identity: { credentials: { type: 'test' } },
        agents: { a: { model: 'm', tools: ['save'], policy: { rules: [{ match: 'save', when: { roles: ['viewer'] }, action: 'deny', reason: 'local' }] } } },
      },
      { registry },
    );
    try {
      const r1 = await rt.run('a', 'go', { identity: analyst });
      assert.deepEqual(factoryOptions, { url: 'http://pdp' });
      assert.equal(r1.status, 'completed');
      assert.equal(pdp.requests.length, 1);
      assert.deepEqual(pdp.requests[0]!.context, { args: {} });
      assert.equal(bound[0], analyst);
      const sink = collectSink();
      await rt.run('a', 'go', { identity: viewer, sinks: [sink] });
      const d = sink.events.find((e) => e.type === 'tool_decision') as RunEvent<'tool_decision'>;
      assert.deepEqual([d.data.allowed, d.data.reason], [false, 'local']);
      assert.equal(pdp.requests.length, 1, 'local deny never reaches the PDP');
    } finally {
      await rt.close();
    }
  });
});
