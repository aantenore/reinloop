import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Runtime } from './config/runtime.ts';
import { describeMembers } from './describe.ts';
import type { Approver, Identity, IdentityVerifier, RunEvent } from './types.ts';
import { limitDefault } from './limits.ts';
import { CONSOLE_HTML } from './ui.ts';
import { errorMessage, isSafeRunId } from './util.ts';

export const DEFAULT_PORT = 7878;

export interface ServeOptions {
  port?: number;
  /** Default 127.0.0.1: exposing agents beyond localhost is an explicit choice. */
  host?: string;
  /** When set, every /v1 request needs `Authorization: Bearer <token>` (or, with `identity`, a valid user token). */
  token?: string;
  /**
   * Verify `Authorization: Bearer <JWT>` and run as that identity (default: the runtime's `identity.verifier`; `false`
   * turns it off). `required` (default true) rejects requests without a token. The static `token` stays valid as an
   * operator credential: it runs without identity and may read every run log.
   */
  identity?: { verifier: IdentityVerifier; required?: boolean } | false;
  /** Serve the web console at `/` (default true). */
  ui?: boolean;
  /** Approver for "ask" decisions; without one they are denied. */
  approve?: Approver;
  /** Largest request body (default 1 MB, or `serve.maxBodyBytes` of the config; Infinity: none). */
  maxBodyBytes?: number;
  /** Time to receive a whole request (default 300 s; Infinity: none). */
  requestTimeoutMs?: number;
  /** Time to receive the request headers (default 60 s, never above `requestTimeoutMs`; Infinity: none). */
  headersTimeoutMs?: number;
  /** Verifier reason kept in the WWW-Authenticate `error_description` (default 120). */
  errorDescriptionChars?: number;
  /**
   * Host header values accepted besides the bound host, `localhost`, `127.0.0.1` and `[::1]` (those with the bound
   * port). `name` matches any port, `name:port` that port only. Other hosts get 403 (DNS rebinding).
   */
  allowedHosts?: string[];
  /**
   * Origins (`https://app.example.com`) whose browser pages may call the API. A request with an Origin header that is
   * neither listed nor the server's own origin gets 403; requests without Origin (CLI, servers) pass. Default: none.
   */
  allowedOrigins?: string[];
  /** Allow a non-loopback `host` without `token` or identity verifier (default: refuse to start). */
  insecure?: boolean;
}

/** `serve` settings of the config file; options passed to `serve()` win. */
export type ServeSettings = Pick<ServeOptions, 'maxBodyBytes' | 'requestTimeoutMs' | 'headersTimeoutMs' | 'errorDescriptionChars' | 'allowedHosts' | 'allowedOrigins' | 'insecure'>;

const LOOPBACK_NAMES = ['localhost', '127.0.0.1', '[::1]'];
const isLoopback = (host: string) => {
  const name = host.replace(/^\[|\]$/g, '').toLowerCase();
  return name === 'localhost' || name === '::1' || /^127(\.\d{1,3}){3}$/.test(name);
};

/** Splits a Host header or an allow-list entry; port is '' when absent. Undefined when it is not a valid authority. */
function parseAuthority(value: string | undefined): { name: string; port: string } | undefined {
  if (!value || /[\s/@?#\\]/.test(value)) return undefined;
  try {
    const u = new URL(`http://${value}`);
    return { name: u.hostname.toLowerCase(), port: u.port || (/:\d+$/.test(value) ? '80' : '') };
  } catch {
    return undefined;
  }
}

/** Node server timeouts: Infinity (unbounded) is 0, which Node reads as "no timeout". */
const nodeTimeout = (ms: number) => (Number.isFinite(ms) ? ms : 0);

export interface Served { server: Server; url: string; close(): Promise<void> }

class HttpError extends Error {
  readonly status: number;
  readonly headers?: Record<string, string>;
  constructor(status: number, message: string, headers?: Record<string, string>) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

async function readBody(req: IncomingMessage, limit: number): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) {
      req.pause();
      throw new HttpError(413, 'request body too large');
    }
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'body must be JSON');
  }
}

function send(res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void {
  // An unread request body would desynchronise a keep-alive connection: close it instead.
  res.writeHead(status, { 'content-type': 'application/json', ...(status === 413 && { connection: 'close' }), ...headers });
  res.end(JSON.stringify(body));
}

const digest = (s: string) => createHash('sha256').update(s).digest();
const sameSecret = (given: string | undefined, expected: string) => given !== undefined && timingSafeEqual(digest(given), digest(expected));

/** RFC 6750 challenge; the description is the verifier's reason, which never contains the token. */
const unauthorized = (error?: string, description?: string) =>
  new HttpError(401, description ? `unauthorized: ${description}` : 'unauthorized', {
    'www-authenticate': `Bearer realm="reinloop"${error ? `, error="${error}"` : ''}${description ? `, error_description="${description.replace(/["\\\r\n]/g, '')}"` : ''}`,
  });

/** Who a request acts as: the operator (static token), a verified identity, or anonymous. */
interface Caller { operator: boolean; identity?: Identity }

/** Subject and identity kind of a stored run (from its first `run_start`); undefined for runs without identity. */
const runSubject = (events: RunEvent[]) => {
  const data = (events.find((e) => e.type === 'run_start') as RunEvent<'run_start'> | undefined)?.data;
  return data?.subject === undefined ? undefined : { subject: data.subject, kind: data.identityKind };
};

/**
 * HTTP API over a runtime:
 *   GET  /v1/agents                  agents and teams
 *   POST /v1/agents/:name/runs       { input, runId? } → RunResult, or SSE events with `Accept: text/event-stream`
 *   GET  /v1/runs, /v1/runs/:id      stored runs and their event logs
 */
export async function serve(runtime: Runtime, opts: ServeOptions = {}): Promise<Served> {
  const settings = runtime.serveSettings?.() ?? {};
  const limit = opts.maxBodyBytes ?? settings.maxBodyBytes ?? limitDefault('serve.maxBodyBytes');
  const descriptionChars = opts.errorDescriptionChars ?? settings.errorDescriptionChars ?? limitDefault('serve.errorDescriptionChars');
  const requestTimeout = nodeTimeout(opts.requestTimeoutMs ?? settings.requestTimeoutMs ?? limitDefault('serve.requestTimeoutMs'));
  const headersTimeout = nodeTimeout(opts.headersTimeoutMs ?? settings.headersTimeoutMs ?? limitDefault('serve.headersTimeoutMs'));
  const verifier = opts.identity === false ? undefined : (opts.identity?.verifier ?? runtime.identity?.verifier);
  const bindHost = opts.host ?? '127.0.0.1';
  const required = opts.identity ? (opts.identity.required ?? true) : (runtime.identity?.required ?? true);
  // A verifier that lets anonymous callers through (`required: false`) does not authenticate the API.
  if (!isLoopback(bindHost) && !opts.token && !(verifier && required) && !(opts.insecure ?? settings.insecure)) {
    throw new Error(`refusing to serve on ${bindHost} without authentication: set a token (--token / REINLOOP_API_TOKEN) or a required identity verifier, or pass --insecure to accept an open API`);
  }
  const authenticate = async (header: string | undefined): Promise<Caller> => {
    if (opts.token && sameSecret(header, `Bearer ${opts.token}`)) return { operator: true };
    if (!verifier) {
      if (opts.token) throw unauthorized();
      return { operator: false };
    }
    const bearer = /^Bearer +(\S+) *$/i.exec(header ?? '')?.[1];
    if (!bearer) {
      // A present but malformed header is never downgraded to an anonymous call.
      if (header || required || opts.token) throw unauthorized(header ? 'invalid_request' : undefined);
      return { operator: false };
    }
    try {
      return { operator: false, identity: await verifier.verify(bearer) };
    } catch (err) {
      // The IdP being unreachable or misconfigured is not the caller's fault (still no access).
      if (String((err as { code?: unknown }).code ?? '').startsWith('identity_')) throw new HttpError(503, 'identity provider unavailable');
      throw unauthorized('invalid_token', errorMessage(err).slice(0, descriptionChars));
    }
  };
  // With identity on, a caller sees and continues only runs started under its own subject; the operator sees all.
  // Runs without a subject (or without a recorded identity kind), and callers without identity, never match: those runs
  // are operator-only. The kind must match too, so a user and an agent sharing a subject string stay apart.
  // Without a verifier serve is an open (local) mode: runs carry no subject and access is not restricted.
  const mayAccess = (caller: Caller, events: RunEvent[]) => {
    if (!verifier || caller.operator) return true;
    const owner = runSubject(events);
    return caller.identity !== undefined && owner !== undefined && owner.kind !== undefined && owner.subject === caller.identity.subject && owner.kind === caller.identity.kind;
  };
  // Browsers cannot forge Host or Origin: the Host allow-list stops DNS rebinding, the Origin check stops cross-site calls.
  const extraHosts = (opts.allowedHosts ?? settings.allowedHosts ?? []).map((h) => ({ raw: h, ...parseAuthority(h) })).filter((h): h is { raw: string; name: string; port: string } => h.name !== undefined);
  const allowedOrigins = new Set((opts.allowedOrigins ?? settings.allowedOrigins ?? []).map((o) => o.toLowerCase().replace(/\/$/, '')));
  let boundPort = '';
  let boundName = '';
  const hostAllowed = (header: string | undefined) => {
    const h = parseAuthority(header);
    if (!h) return false;
    const port = h.port || '80'; // a Host header without port means the http default
    if ([...LOOPBACK_NAMES, boundName].some((n) => n === h.name) && port === boundPort) return true;
    return extraHosts.some((e) => e.name === h.name && (!e.port || e.port === port));
  };
  const originAllowed = (origin: string, host: string | undefined) => {
    const o = origin.toLowerCase().replace(/\/$/, '');
    return allowedOrigins.has(o) || o === `http://${(host ?? '').toLowerCase()}`; // the console served by this very server
  };
  // As in Node: the headers timeout never exceeds the request timeout (0 turns either off).
  const serverOptions = { requestTimeout, headersTimeout: requestTimeout && headersTimeout ? Math.min(headersTimeout, requestTimeout) : headersTimeout };
  const inflight = new Set<string>();
  const server = createServer(serverOptions, async (req, res) => {
    let busy: string | undefined;
    try {
      // Liveness probe: returns no data, so load balancers may call it with any Host.
      if (req.method === 'GET' && (req.url === '/health' || req.url?.startsWith('/health?'))) return send(res, 200, { ok: true });
      if (!hostAllowed(req.headers.host)) throw new HttpError(403, 'host not allowed');
      const origin = req.headers.origin;
      if (origin !== undefined && !originAllowed(origin, req.headers.host)) throw new HttpError(403, 'origin not allowed');
      const url = new URL(req.url ?? '/', 'http://local');
      const path = url.pathname;
      if (req.method === 'GET' && path === '/' && opts.ui !== false) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(CONSOLE_HTML);
      }
      if (!path.startsWith('/v1/')) throw new HttpError(404, 'not found');
      const caller = await authenticate(req.headers.authorization);

      if (req.method === 'GET' && path === '/v1/agents') return send(res, 200, describeMembers(runtime));
      if (req.method === 'GET' && path === '/v1/runs') {
        if (verifier && !caller.operator) throw new HttpError(403, 'listing runs needs the operator token');
        return send(res, 200, (await runtime.store.list?.()) ?? []);
      }
      const runMatch = /^\/v1\/runs\/([\w.-]+)$/.exec(path);
      if (req.method === 'GET' && runMatch) {
        if (!isSafeRunId(runMatch[1])) throw new HttpError(404, 'not found');
        const events = await runtime.store.load(runMatch[1]);
        if (!mayAccess(caller, events)) throw new HttpError(404, 'not found');
        return send(res, 200, events);
      }

      const start = /^\/v1\/agents\/([\w.-]+)\/runs$/.exec(path);
      if (req.method === 'POST' && start) {
        const name = decodeURIComponent(start[1]!);
        if (!runtime.names().includes(name)) throw new HttpError(404, `unknown agent "${name}"`);
        // Only JSON: a cross-site form or text/plain POST is a "simple" request browsers send without preflight.
        if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'content-type must be application/json');
        const body = await readBody(req, limit);
        if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'body must be a JSON object');
        if (body.input !== undefined && typeof body.input !== 'string') throw new HttpError(400, '"input" must be a string');
        if (body.runId !== undefined && !isSafeRunId(body.runId)) throw new HttpError(400, '"runId" must be 1-128 characters of letters, digits, "_", "-" or "." (not first)');
        // One request per run id at a time: the ownership check below and the run itself must not interleave.
        if (body.runId !== undefined) {
          if (inflight.has(body.runId)) throw new HttpError(409, 'run busy');
          inflight.add(body.runId);
          busy = body.runId;
        }
        if (body.runId !== undefined && verifier && !caller.operator) {
          const prior = await runtime.store.load(body.runId);
          if (prior.length && !mayAccess(caller, prior)) throw new HttpError(404, 'not found');
        }
        const controller = new AbortController();
        res.on('close', () => !res.writableFinished && controller.abort(new Error('client disconnected')));
        const handle = await runtime.stream(name, body.input, { runId: body.runId, approve: opts.approve, signal: controller.signal, ...(caller.identity && { identity: caller.identity }) });
        const wantsStream = (req.headers.accept ?? '').includes('text/event-stream') || url.searchParams.get('stream') === '1';
        if (!wantsStream) {
          const result = await handle.result;
          return send(res, 200, { ...result, messages: undefined });
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        for await (const ev of handle) res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
        const result = await handle.result;
        res.write(`event: result\ndata: ${JSON.stringify({ ...result, messages: undefined })}\n\n`);
        return res.end();
      }
      throw new HttpError(404, 'not found');
    } catch (err) {
      if (res.headersSent) return res.end();
      const status = err instanceof HttpError ? err.status : 500;
      send(res, status, { error: errorMessage(err) }, err instanceof HttpError ? err.headers : undefined);
      if (status === 413) res.once('finish', () => req.destroy());
    } finally {
      if (busy !== undefined) inflight.delete(busy);
    }
  });
  const port = opts.port ?? DEFAULT_PORT;
  await new Promise<void>((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) =>
      reject(err.code === 'EADDRINUSE' ? new Error(`port ${port} is already in use; pass --port <n>`) : err),
    );
    server.listen(port, bindHost, resolve);
  });
  const { address } = server.address() as AddressInfo;
  const bound = (server.address() as AddressInfo).port;
  boundPort = String(bound);
  boundName = (bindHost.includes(':') ? `[${bindHost}]` : bindHost).toLowerCase();
  const host = address.includes(':') ? `[${address}]` : address;
  return {
    server,
    url: `http://${host}:${bound}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
