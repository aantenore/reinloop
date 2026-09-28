import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Runtime } from './config/runtime.ts';
import { describeMembers } from './describe.ts';
import type { Approver } from './types.ts';
import { CONSOLE_HTML } from './ui.ts';
import { errorMessage } from './util.ts';

export const DEFAULT_PORT = 7878;

export interface ServeOptions {
  port?: number;
  /** Default 127.0.0.1: exposing agents beyond localhost is an explicit choice. */
  host?: string;
  /** When set, every /v1 request needs `Authorization: Bearer <token>`. */
  token?: string;
  /** Serve the web console at `/` (default true). */
  ui?: boolean;
  /** Approver for "ask" decisions; without one they are denied. */
  approve?: Approver;
  maxBodyBytes?: number;
}

export interface Served { server: Server; url: string; close(): Promise<void> }

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
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

function send(res: ServerResponse, status: number, body: unknown): void {
  // An unread request body would desynchronise a keep-alive connection: close it instead.
  res.writeHead(status, { 'content-type': 'application/json', ...(status === 413 && { connection: 'close' }) });
  res.end(JSON.stringify(body));
}

const digest = (s: string) => createHash('sha256').update(s).digest();
const sameSecret = (given: string | undefined, expected: string) => given !== undefined && timingSafeEqual(digest(given), digest(expected));

/**
 * HTTP API over a runtime:
 *   GET  /v1/agents                  agents and teams
 *   POST /v1/agents/:name/runs       { input, runId? } → RunResult, or SSE events with `Accept: text/event-stream`
 *   GET  /v1/runs, /v1/runs/:id      stored runs and their event logs
 */
export async function serve(runtime: Runtime, opts: ServeOptions = {}): Promise<Served> {
  const limit = opts.maxBodyBytes ?? 1_000_000;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://local');
      const path = url.pathname;
      if (req.method === 'GET' && path === '/' && opts.ui !== false) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(CONSOLE_HTML);
      }
      if (path === '/health') return send(res, 200, { ok: true });
      if (!path.startsWith('/v1/')) throw new HttpError(404, 'not found');
      if (opts.token && !sameSecret(req.headers.authorization, `Bearer ${opts.token}`)) throw new HttpError(401, 'unauthorized');

      if (req.method === 'GET' && path === '/v1/agents') return send(res, 200, describeMembers(runtime));
      if (req.method === 'GET' && path === '/v1/runs') return send(res, 200, (await runtime.store.list?.()) ?? []);
      const runMatch = /^\/v1\/runs\/([\w.-]+)$/.exec(path);
      if (req.method === 'GET' && runMatch) return send(res, 200, await runtime.store.load(runMatch[1]!));

      const start = /^\/v1\/agents\/([\w.-]+)\/runs$/.exec(path);
      if (req.method === 'POST' && start) {
        const name = decodeURIComponent(start[1]!);
        if (!runtime.names().includes(name)) throw new HttpError(404, `unknown agent "${name}"`);
        const body = await readBody(req, limit);
        if (body.input !== undefined && typeof body.input !== 'string') throw new HttpError(400, '"input" must be a string');
        if (body.runId !== undefined && typeof body.runId !== 'string') throw new HttpError(400, '"runId" must be a string');
        const controller = new AbortController();
        res.on('close', () => !res.writableFinished && controller.abort(new Error('client disconnected')));
        const handle = await runtime.stream(name, body.input, { runId: body.runId, approve: opts.approve, signal: controller.signal });
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
      send(res, status, { error: errorMessage(err) });
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
