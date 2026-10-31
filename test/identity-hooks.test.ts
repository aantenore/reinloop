import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import {
  accessQuestion, authorizeCall, collectSink, createRegistry, createRuntime, decide, defineTool, IdentityError, mcpTools, memoryStore, run, serve,
  type AccessQuestion, type Authorizer, type HarnessConfig, type Identity, type IdentityVerifier, type RunEvent, type Tool, type ToolCallPart,
} from '../src/index.ts';
import { makeAgent } from './helpers.ts';

// ---- helpers -------------------------------------------------------------------------------------------------------

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

function recordingAuthorizer(answer: (q: AccessQuestion) => boolean | Error): Authorizer & { requests: AccessQuestion[] } {
  const requests: AccessQuestion[] = [];
  return {
    requests,
    async evaluate(req) {
      requests.push(req);
      const out = answer(req);
      if (out instanceof Error) throw out;
      return { decision: out, ...(!out && { reason: `${req.caller.id} may not ${req.target.id}` }) };
    },
  };
}

describe('pdp', () => {
  const agent = 'helper';
  it('local deny wins without asking the PDP; PDP deny and errors deny; allow keeps ask', async () => {
    const pdp = recordingAuthorizer((r) => r.caller.id === 'alice');
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

  it('builds access questions in SDK names, anonymous without identity, with args only on opt-in', () => {
    const q = accessQuestion(call('edit', { path: '/etc/x' }), { ...tool('edit', 'write'), layer: 'tool' }, agent, analyst);
    assert.deepEqual(q, {
      caller: { id: 'alice', kind: 'user', roles: ['analyst'], scopes: ['tools.write'] },
      action: 'call',
      target: { kind: 'tool', id: 'edit', layer: 'tool', risk: 'write', agent },
    });
    assert.deepEqual(accessQuestion(call('edit', { a: 1 }), tool('edit', 'write'), agent, analyst, true).args, { a: 1 });
    assert.deepEqual(accessQuestion(call('x'), tool('x', 'read'), agent, undefined).caller, { kind: 'anonymous', id: 'anonymous', roles: [], scopes: [] });
    assert.ok(!JSON.stringify(q).includes('SECRET'));
  });

  it('denies through a run, puts the reason on tool_decision and never a token in events or the store', async () => {
    const pdp = recordingAuthorizer((r) => r.caller.roles.includes('analyst'));
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
    assert.equal(pdp.requests[0]!.args, undefined);
    const all = JSON.stringify(sink.events) + JSON.stringify(await store.load(res.runId));
    for (const secret of [viewer.token!, exchanged]) assert.ok(!all.includes(secret), 'no token in events');
    assert.deepEqual(seen, []);
  });
});

describe('serve with identity', () => {
  // Verifiers come from plugins: a test verifier maps known tokens to identities and fails like an unreachable IdP on `down`.
  const tokens: Record<string, Identity> = { 'tok-alice': { subject: 'alice-id', kind: 'user', token: 'tok-alice' }, 'tok-bob': { subject: 'bob-id', kind: 'user', token: 'tok-bob' } };
  const staticVerifier = (): IdentityVerifier => ({
    async verify(token) {
      if (token === 'down') throw new IdentityError('identity_unavailable', 'provider unreachable');
      const id = tokens[token];
      if (!id) throw new Error('token expired');
      return id;
    },
  });
  const registry = () => {
    const r = createRegistry();
    r.verifiers.set('static', () => staticVerifier());
    return r;
  };
  const config = (identity: HarnessConfig['identity']): HarnessConfig => ({
    providers: { mock: { type: 'mock', responses: [{ text: 'hello' }], loop: true } },
    models: { m: { provider: 'mock', model: 'mock-1' } },
    agents: { echo: { model: 'm', description: 'Echo' } },
    identity,
  });

  it('401 without or with a bad token, runs as the verified identity, keeps the static token, isolates runs', async () => {
    const rt = await createRuntime(config({ verifier: { type: 'static' } }), { registry: registry() });
    const served = await serve(rt, { port: 0, token: 'operator-key' });
    const post = (headers: Record<string, string>, body: unknown = { input: 'hi' }) =>
      fetch(`${served.url}/v1/agents/echo/runs`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    try {
      const none = await post({});
      assert.equal(none.status, 401);
      assert.match(none.headers.get('www-authenticate')!, /^Bearer realm="reinloop"/);
      const expired = await post({ authorization: 'Bearer tok-unknown' });
      assert.equal(expired.status, 401);
      assert.match(expired.headers.get('www-authenticate')!, /error="invalid_token", error_description="token expired"/);
      assert.equal((await post({ authorization: 'Basic abc' })).status, 401);

      const ok = await post({ authorization: 'Bearer tok-alice' });
      assert.equal(ok.status, 200);
      const result = await ok.json();
      const events = (await rt.store.load(result.runId)) as RunEvent[];
      const start = events.find((e) => e.type === 'run_start') as RunEvent<'run_start'>;
      assert.deepEqual([start.data.subject, start.data.identityKind], ['alice-id', 'user']);
      assert.ok(!JSON.stringify(events).includes('tok-alice'));

      assert.equal((await fetch(`${served.url}/v1/runs/${result.runId}`, { headers: { authorization: 'Bearer tok-bob' } })).status, 404);
      assert.equal((await post({ authorization: 'Bearer tok-bob' }, { input: 'x', runId: result.runId })).status, 404);
      assert.equal((await fetch(`${served.url}/v1/runs/${result.runId}`, { headers: { authorization: 'Bearer tok-alice' } })).status, 200);
      assert.equal((await fetch(`${served.url}/v1/runs`, { headers: { authorization: 'Bearer tok-alice' } })).status, 403);
      assert.equal((await fetch(`${served.url}/v1/runs`, { headers: { authorization: 'Bearer operator-key' } })).status, 200);
      assert.equal((await post({ authorization: 'Bearer operator-key' })).status, 200);
    } finally {
      await served.close();
      await rt.close();
    }
  });

  it('optional identity: anonymous calls pass, invalid tokens still fail; 503 when the provider is down', async () => {
    const rt = await createRuntime(config({ verifier: { type: 'static' }, required: false }), { registry: registry() });
    const served = await serve(rt, { port: 0 });
    try {
      assert.equal((await fetch(`${served.url}/v1/agents`)).status, 200);
      assert.equal((await fetch(`${served.url}/v1/agents`, { headers: { authorization: 'Bearer junk' } })).status, 401);
      assert.equal((await fetch(`${served.url}/v1/agents`, { headers: { authorization: 'Bearer down' } })).status, 503);
    } finally {
      await served.close();
      await rt.close();
    }
  });

  it('a verifier passed to serve() needs no config; an unregistered type points to plugins', async () => {
    const rt = await createRuntime(config(undefined));
    const served = await serve(rt, { port: 0, identity: { verifier: staticVerifier() } });
    try {
      assert.equal((await fetch(`${served.url}/v1/agents`)).status, 401);
      assert.equal((await fetch(`${served.url}/v1/agents`, { headers: { authorization: 'Bearer tok-alice' } })).status, 200);
    } finally {
      await served.close();
      await rt.close();
    }
    await assert.rejects(createRuntime(config({ verifier: { type: 'oidc' } })), /identity\.verifier\.type: unknown identity verifier "oidc" \(none registered; load a plugin.*agent-layers/);
    await assert.rejects(createRuntime(config({ verifier: {} as never })), /identity\.verifier\.type: required/);
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

  it('connects configured MCP servers with the credentials factory called without identity', async () => {
    auths.length = 0;
    const registry = createRegistry();
    const bound: Array<Identity | undefined> = [];
    registry.credentials.set('test', () => (identity?: Identity) => (bound.push(identity), { token: async (aud: string) => `${identity?.subject ?? 'self'}-${aud}` }));
    const rt = await createRuntime(
      {
        providers: { mock: { type: 'mock', responses: [{ text: 'done' }], loop: true } },
        models: { m: { provider: 'mock', model: 'mock-1' } },
        mcpServers: { api: { url: mcp.url, auth: { audience: 'tools-api' } } },
        identity: { credentials: { type: 'test' } },
        agents: { a: { model: 'm', tools: ['api__*'] } },
      },
      { registry },
    );
    try {
      await rt.agent('a');
      assert.equal(bound[0], undefined);
      assert.equal(auths[0]!.authorization, 'Bearer self-tools-api');
    } finally {
      await rt.close();
    }
  });

  it('builds the PDP from config through the registry and binds credentials per run', async () => {
    const registry = createRegistry();
    const pdp = recordingAuthorizer((r) => r.caller.id === 'alice');
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
      assert.deepEqual(pdp.requests[0]!.args, {});
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
