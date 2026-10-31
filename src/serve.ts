import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Runtime } from './config/runtime.ts';
import { describeMembers } from './describe.ts';
import type { Approver, Identity, IdentityVerifier, RunEvent } from './types.ts';
import { limitDefault } from './limits.ts';
import { CONSOLE_HTML } from './ui.ts';
import { errorMessage } from './util.ts';

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
}

/** `serve` settings of the config file; options passed to `serve()` win. */
export type ServeSettings = Pick<ServeOptions, 'maxBodyBytes' | 'requestTimeoutMs' | 'headersTimeoutMs' | 'errorDescriptionChars'>;

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

/** Subject of a stored run (from its first `run_start`); undefined for runs without identity. */
const runSubject = (events: RunEvent[]) => (events.find((e) => e.type === 'run_start') as RunEvent<'run_start'> | undefined)?.data.subject;

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
  const required = opts.identity ? (opts.identity.required ?? true) : (runtime.identity?.required ?? true);
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
  const mayAccess = (caller: Caller, events: RunEvent[]) => !verifier || caller.operator || runSubject(events) === caller.identity?.subject;
  // As in Node: the headers timeout never exceeds the request timeout (0 turns either off).
  const serverOptions = { requestTimeout, headersTimeout: requestTimeout && headersTimeout ? Math.min(headersTimeout, requestTimeout) : headersTimeout };
  const server = createServer(serverOptions, async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://local');
      const path = url.pathname;
      if (req.method === 'GET' && path === '/' && opts.ui !== false) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(CONSOLE_HTML);
      }
      if (path === '/health') return send(res, 200, { ok: true });
      if (!path.startsWith('/v1/')) throw new HttpError(404, 'not found');
      const caller = await authenticate(req.headers.authorization);

      if (req.method === 'GET' && path === '/v1/agents') return send(res, 200, describeMembers(runtime));
      if (req.method === 'GET' && path === '/v1/runs') {
        if (verifier && !caller.operator) throw new HttpError(403, 'listing runs needs the operator token');
        return send(res, 200, (await runtime.store.list?.()) ?? []);
      }
      const runMatch = /^\/v1\/runs\/([\w.-]+)$/.exec(path);
      if (req.method === 'GET' && runMatch) {
        const events = await runtime.store.load(runMatch[1]!);
        if (!mayAccess(caller, events)) throw new HttpError(404, 'not found');
        return send(res, 200, events);
      }

      const start = /^\/v1\/agents\/([\w.-]+)\/runs$/.exec(path);
      if (req.method === 'POST' && start) {
        const name = decodeURIComponent(start[1]!);
        if (!runtime.names().includes(name)) throw new HttpError(404, `unknown agent "${name}"`);
        const body = await readBody(req, limit);
        if (body.input !== undefined && typeof body.input !== 'string') throw new HttpError(400, '"input" must be a string');
        if (body.runId !== undefined && typeof body.runId !== 'string') throw new HttpError(400, '"runId" must be a string');
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
    }
  });
  const port = opts.port ?? DEFAULT_PORT;
  await new Promise<void>((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) =>
      reject(err.code === 'EADDRINUSE' ? new Error(`port ${port} is already in use; pass --port <n>`) : err),
    );
    server.listen(port, opts.host ?? '127.0.0.1', resolve);
  });
  const { address } = server.address() as AddressInfo;
  const bound = (server.address() as AddressInfo).port;
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
