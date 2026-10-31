import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createRuntime, httpTool, openapiTools, type Agent, type CredentialProvider, type ToolContext } from '../src/index.ts';

interface Seen { method: string; url: string; headers: IncomingMessage['headers']; body: string }

let server: Server;
let base: string;
let seen: Seen[] = [];

before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      const url = new URL(req.url!, 'http://x');
      if (url.pathname === '/missing') return void res.writeHead(404, { 'content-type': 'text/plain' }).end('no such thing');
      if (url.pathname === '/png') return void res.writeHead(200, { 'content-type': 'image/png' }).end(Buffer.alloc(10));
      if (url.pathname === '/empty') return void res.writeHead(204).end();
      if (url.pathname === '/big') return void res.writeHead(200, { 'content-type': 'text/plain' }).end('x'.repeat(500));
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ path: url.pathname, query: url.search, auth: req.headers.authorization ?? null, body }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((r) => server.close(() => r())));

const ctx = (extra: Partial<ToolContext> = {}) => ({ signal: new AbortController().signal, ...extra }) as ToolContext;
const run = async (tool: any, args: unknown, c = ctx()) => {
  const out = await tool.run(args, c);
  return typeof out === 'string' ? { content: out, isError: false } : out;
};
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

describe('httpTool', () => {
  it('fills encoded path params, query (arrays repeat) and header args', async () => {
    seen = [];
    const tool = httpTool({
      name: 'get_item', description: 'd', method: 'GET', url: `${base}/items/{id}`, query: ['tag', 'q'], headerArgs: ['x-trace'], headers: { 'x-static': '${env:HDR}' },
      env: { HDR: 'from-env' }, schema: schema({ id: { type: 'string' }, tag: {}, q: {}, 'x-trace': {} }, ['id']),
    });
    assert.equal(tool.risk, 'read');
    assert.equal(tool.layer, 'tool');
    const out = await run(tool, { id: 'a/b c', tag: ['x', 'y'], q: 'é', 'x-trace': 't1' });
    assert.equal(out.isError, false);
    assert.equal(seen[0]!.url, '/items/a%2Fb%20c?tag=x&tag=y&q=%C3%A9');
    assert.equal(seen[0]!.headers['x-static'], 'from-env');
    assert.equal(seen[0]!.headers['x-trace'], 't1');
    assert.match(out.content, /\n {2}"path": "\/items\/a%2Fb%20c"/); // pretty-printed
  });

  it('sends remaining args as the JSON body, or only bodyArg', async () => {
    seen = [];
    const create = httpTool({ name: 'create', description: 'd', method: 'POST', url: `${base}/things/{id}`, query: ['dry'], body: 'json', schema: schema({}) });
    assert.equal(create.risk, 'write');
    await run(create, { id: 7, dry: true, name: 'n', n: 1 });
    assert.equal(seen[0]!.url, '/things/7?dry=true');
    assert.equal(seen[0]!.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(seen[0]!.body), { name: 'n', n: 1 });

    seen = [];
    const put = httpTool({ name: 'put', description: 'd', method: 'PUT', url: `${base}/x`, body: 'json', bodyArg: 'payload', schema: schema({}) });
    await run(put, { payload: [1, 2] });
    assert.deepEqual(JSON.parse(seen[0]!.body), [1, 2]);
  });

  it('reports missing path params, non-2xx, binary and empty responses', async () => {
    const missing = httpTool({ name: 'm', description: 'd', method: 'GET', url: `${base}/items/{id}`, schema: schema({}) });
    assert.deepEqual(await run(missing, {}), { content: 'Missing path parameter(s): id', isError: true });

    const nf = httpTool({ name: 'nf', description: 'd', method: 'GET', url: `${base}/missing`, schema: schema({}) });
    const err = await run(nf, {});
    assert.equal(err.isError, true);
    assert.match(err.content, /^HTTP 404.*: no such thing$/);

    assert.match((await run(httpTool({ name: 'p', description: 'd', method: 'GET', url: `${base}/png`, schema: schema({}) }), {})).content, /^HTTP 200: 10 bytes of image\/png/);
    assert.equal((await run(httpTool({ name: 'e', description: 'd', method: 'GET', url: `${base}/empty`, schema: schema({}) }), {})).content, 'HTTP 204 (no content)');
  });

  it('truncates long responses', async () => {
    const tool = httpTool({ name: 'big', description: 'd', method: 'GET', url: `${base}/big`, maxResultChars: 100, schema: schema({}) });
    const out = await run(tool, {});
    assert.equal(out.content, `${'x'.repeat(100)}\n[truncated: 500 chars in total]`);
  });

  it('rejects invalid definitions', () => {
    const o = { name: 'x', description: 'd', url: base, schema: schema({}) };
    assert.throws(() => httpTool({ ...o, method: 'GET', body: 'json' }), /cannot have a body/);
    assert.throws(() => httpTool({ ...o, method: 'TRACE' as any }), /unsupported method/);
    assert.throws(() => httpTool({ ...o, method: 'GET', headers: { a: '${env:NOPE_X}' }, env: {} }), /NOPE_X is not set/);
    assert.throws(() => httpTool({ ...o, name: 'bad name', method: 'GET' }), /invalid tool name/);
  });

  it('sends a bearer token from the run credentials and never leaks it back', async () => {
    seen = [];
    const calls: Array<{ audience: string; scopes?: string[] }> = [];
    const credentials: CredentialProvider = { async token(audience, o) { calls.push({ audience, scopes: o?.scopes }); return 'tok-secret-123'; } };
    const tool = httpTool({ name: 'secure', description: 'd', method: 'GET', url: `${base}/me`, headers: { authorization: 'Bearer static' }, auth: { audience: 'tools-api', scopes: ['read'] }, schema: schema({}) });
    const out = await run(tool, {}, ctx({ credentials }));
    assert.deepEqual(calls, [{ audience: 'tools-api', scopes: ['read'] }]);
    assert.equal(seen[0]!.headers.authorization, 'Bearer tok-secret-123');
    assert.equal(out.isError, false);
    assert.doesNotMatch(out.content, /tok-secret-123/); // the server echoed it; it is redacted
    assert.match(out.content, /Bearer \[redacted\]/);
  });

  it('never calls out without credentials, or when the token request fails', async () => {
    seen = [];
    const tool = httpTool({ name: 'secure', description: 'd', method: 'GET', url: `${base}/me`, auth: { audience: 'tools-api' }, schema: schema({}) });
    const none = await run(tool, {});
    assert.equal(none.isError, true);
    assert.match(none.content, /needs credentials for audience "tools-api".*not sent/);
    const failing: CredentialProvider = { async token() { throw new Error('exchange denied'); } };
    const denied = await run(tool, {}, ctx({ credentials: failing }));
    assert.equal(denied.isError, true);
    assert.match(denied.content, /exchange denied/);
    assert.equal(seen.length, 0);
  });
});

const spec = (extra: Record<string, unknown> = {}) => ({
  openapi: '3.0.3',
  info: { title: 't', version: '1' },
  servers: [{ url: '/v1' }],
  paths: {
    '/pets/{petId}': {
      parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'integer' } }],
      get: {
        operationId: 'getPet',
        summary: 'Get a pet',
        parameters: [
          { name: 'verbose', in: 'query', schema: { type: 'boolean' } },
          { name: 'X-Trace', in: 'header', schema: { type: 'string' } },
          { name: 'Authorization', in: 'header', schema: { type: 'string' } },
        ],
      },
      delete: { operationId: 'deletePet' },
    },
    '/pets': {
      post: {
        operationId: 'addPet',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } },
      },
      put: {
        operationId: 'replaceAll',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Pet' } } } } },
      },
      patch: { operationId: 'upload', requestBody: { content: { 'multipart/form-data': { schema: { type: 'object' } } } } },
    },
  },
  components: {
    schemas: {
      Pet: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' }, owner: { $ref: '#/components/schemas/Owner' }, note: { type: 'string', nullable: true } },
      },
      Owner: { type: 'object', properties: { name: { type: 'string' }, pets: { type: 'array', items: { $ref: '#/components/schemas/Pet' } } } },
    },
  },
  ...extra,
});

describe('openapiTools', () => {
  it('converts parameters and bodies to tool schemas, resolving local $ref', () => {
    const tools = openapiTools(spec(), { baseUrl: base, prefix: 'pets' });
    assert.deepEqual(tools.map((t) => t.name).sort(), ['pets__addPet', 'pets__deletePet', 'pets__getPet', 'pets__replaceAll']); // multipart skipped
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));

    const get = by.pets__getPet!;
    assert.equal(get.risk, 'read');
    assert.equal(get.description, 'Get a pet');
    assert.deepEqual(get.schema, {
      type: 'object',
      properties: { petId: { type: 'integer' }, verbose: { type: 'boolean' }, 'X-Trace': { type: 'string' } },
      required: ['petId'],
      additionalProperties: false,
    });
    assert.equal(by.pets__deletePet!.risk, 'write');

    const add: any = by.pets__addPet!.schema;
    assert.deepEqual(add.required, ['name']); // flattened body
    assert.deepEqual(add.properties.note.type, ['string', 'null']);
    assert.equal(add.properties.owner.properties.name.type, 'string');
    assert.deepEqual(add.properties.owner.properties.pets.items, {}); // recursion is cut

    const all: any = by.pets__replaceAll!.schema;
    assert.deepEqual(all.required, ['body']); // non-object body goes under "body"
    assert.equal(all.properties.body.type, 'array');
  });

  it('honours include globs, risk and rejects non-OpenAPI-3 or relative servers', () => {
    const only = openapiTools(spec(), { baseUrl: base, include: ['get*', 'add*'], risk: () => 'exec' });
    assert.deepEqual(only.map((t) => t.name), ['getPet', 'addPet']);
    assert.ok(only.every((t) => t.risk === 'exec'));
    assert.throws(() => openapiTools({ swagger: '2.0' } as any), /not an OpenAPI 3/);
    assert.throws(() => openapiTools(spec()), /absolute "baseUrl"/);
    assert.equal(openapiTools(spec({ servers: [{ url: '{proto}://api.example/v1/', variables: { proto: { default: 'https' } } }] })).length, 4);
    assert.throws(() => openapiTools(spec({ paths: { '/x': { get: { operationId: 'x', requestBody: { content: { 'application/json': { schema: { $ref: 'https://e/x' } } } } } } } }), { baseUrl: base }), /unsupported \$ref/);
  });

  it('calls the API with the generated request', async () => {
    seen = [];
    const credentials: CredentialProvider = { async token() { return 't0k'; } };
    const tools = Object.fromEntries(openapiTools(spec(), { baseUrl: `${base}/v1/`, auth: { audience: 'api' } }).map((t) => [t.name, t]));
    await run(tools.getPet, { petId: 3, verbose: true, 'X-Trace': 'z' }, ctx({ credentials }));
    assert.equal(seen[0]!.url, '/v1/pets/3?verbose=true');
    assert.equal(seen[0]!.headers['x-trace'], 'z');
    assert.equal(seen[0]!.headers.authorization, 'Bearer t0k');
    await run(tools.addPet, { name: 'rex', note: null }, ctx({ credentials }));
    assert.equal(seen[1]!.method, 'POST');
    assert.deepEqual(JSON.parse(seen[1]!.body), { name: 'rex', note: null });
    await run(tools.replaceAll, { body: [{ name: 'a' }] }, ctx({ credentials }));
    assert.deepEqual(JSON.parse(seen[2]!.body), [{ name: 'a' }]);
  });
});

describe('config: httpTools and openapi', () => {
  it('resolves declared tools by name, glob and source in agent tool lists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reinloop-http-'));
    await writeFile(join(dir, 'pets.json'), JSON.stringify(spec()));
    const config = {
      providers: { mock: { type: 'mock', responses: [{ toolCalls: [{ name: 'echo_path', args: { id: 'q' } }] }, { text: 'done' }] } },
      models: { m: { provider: 'mock', model: 'mock-a' } },
      httpTools: { echo_path: { description: 'd', method: 'GET' as const, url: '${env:API}/echo/{id}', schema: schema({ id: { type: 'string' } }, ['id']) } },
      openapi: { pets: { spec: './pets.json', baseUrl: '${env:API}/v1' } },
      agents: {
        a: { model: 'm', tools: ['echo_path', 'pets__get*'] },
        b: { model: 'm', tools: ['openapi:pets'] },
        c: { model: 'm', tools: ['pets__nope'] },
        d: { model: 'm', tools: ['http*'] },
      },
    };
    seen = [];
    const rt = await createRuntime(config, { env: { API: base }, baseDir: dir });
    const names = async (n: string) => ((await rt.agent(n)) as Agent).tools.map((t) => t.name).sort();
    assert.deepEqual(await names('a'), ['echo_path', 'pets__getPet']);
    assert.equal((await names('b')).length, 4);
    await assert.rejects(rt.agent('c'), /"pets__nope" matches no tool of OpenAPI source "pets"/);
    await assert.rejects(rt.agent('d'), /matches no registered tool/);
    const res = await rt.run('a', 'go');
    assert.equal(res.output, 'done');
    assert.equal(seen[0]!.url, '/echo/q');
    await rt.close();
  });

  it('validates the config shape', async () => {
    const bad = { httpTools: { x: { description: 'd', method: 'FETCH', url: 'u', schema: {} } }, openapi: { y: { spec: 's', extra: 1 } } };
    await assert.rejects(createRuntime(bad as any, { env: {} }), /httpTools\.x\.method[\s\S]*openapi\.y\.extra: unknown property/);
  });
});
