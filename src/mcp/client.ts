import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { readSse } from '../providers/http.ts';
import { defineTool, safeToolName } from '../tools/define.ts';
import { redact, scrubError, secretForms, staticSecrets } from '../tools/redact.ts';
import type { CredentialProvider, JsonSchema, Risk, Tool } from '../types.ts';
import { finiteTimeout, limitDefault } from '../limits.ts';
import { globToRegExp } from '../util.ts';
import { VERSION } from '../version.ts';

export const MCP_PROTOCOL_VERSION = '2025-06-18';

export interface McpServerConfig {
  /** stdio transport */
  command?: string;
  args?: string[];
  /** Variables set for the server, on top of the minimal base environment (see `inheritEnv`). */
  env?: Record<string, string>;
  /**
   * Names of parent environment variables passed to the server in addition to the minimal base (`MCP_BASE_ENV`);
   * `"*"` passes the whole parent environment. Without it a server never sees provider keys or other secrets of the process.
   */
  inheritEnv?: string[];
  cwd?: string;
  /** Streamable HTTP transport */
  url?: string;
  headers?: Record<string, string>;
  /** Tool name prefix; defaults to the server name. Tools are exposed as `<prefix>__<tool>`; `false` or `''` keeps the server's own names. */
  prefix?: string | false;
  /** Force a risk level for every tool; otherwise derived from MCP tool annotations. */
  risk?: Risk;
  /** Globs of tools known to be read-only when the server does not annotate them (risk "read"). */
  readOnly?: string[];
  include?: string[];
  exclude?: string[];
  /** Time limit of one request (default 60 s; Infinity: none). */
  timeoutMs?: number;
  /** HTTP error body kept in error messages, after masking (default 300). */
  errorBodyChars?: number;
  /** Tail of a stdio server's stderr kept for error messages (default 2000). */
  stderrChars?: number;
  /** Per-identity sessions kept open with `auth` (default 100); the least recently used is dropped. */
  maxSessions?: number;
  /**
   * Streamable HTTP only: send `Authorization: Bearer` with a token for `audience` from the run's credentials on every
   * tool call (overrides a static `headers.authorization`). Connection setup uses the `connect` credentials, if any.
   * Calls with a run credential use an MCP session of their own (per identity, or per token without one), never the connection's or another caller's.
   */
  auth?: { audience: string; scopes?: string[] };
}

export interface McpConnectOptions {
  /** Credentials for requests outside a run (initialize, tools/list, session close) when `auth` is set. */
  credentials?: CredentialProvider;
  /** Shorter secrets are not masked in error text (default 4). */
  minSecretChars?: number;
}

/** `AbortSignal.timeout` for a time limit that may be Infinity (then only `signal` applies). */
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal | undefined {
  const ms = finiteTimeout(timeoutMs);
  if (ms === undefined) return signal;
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
}

type HeaderMap = Record<string, string>;

/** Parent variables a stdio server always receives: enough to locate binaries, a home and temp directory, and the locale (plus the Windows basics). */
export const MCP_BASE_ENV: readonly string[] = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR',
  'TEMP', 'TMP', 'SystemRoot', 'windir', 'COMSPEC', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'USERNAME', 'HOMEDRIVE', 'HOMEPATH', 'ProgramData', 'ProgramFiles',
];

/** Environment of a stdio server: the base allowlist, then `inheritEnv`, then `env` (which wins). */
export function mcpChildEnv(cfg: Pick<McpServerConfig, 'env' | 'inheritEnv'>, parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  const names = cfg.inheritEnv?.includes('*') ? Object.keys(parent) : [...MCP_BASE_ENV, ...(cfg.inheritEnv ?? [])];
  for (const name of names) if (parent[name] !== undefined) out[name] = parent[name];
  return { ...out, ...cfg.env };
}

/** Static headers plus credentials; a credential header replaces a static one of any letter case. */
function withAuth(base: HeaderMap | undefined, auth: HeaderMap | undefined): HeaderMap {
  if (!auth) return { ...base };
  const names = new Set(Object.keys(auth).map((k) => k.toLowerCase()));
  return { ...Object.fromEntries(Object.entries(base ?? {}).filter(([k]) => !names.has(k.toLowerCase()))), ...auth };
}

interface Transport {
  /** `sessionKey` (HTTP): the MCP session of one identity; without it the connection's session is used. */
  request(method: string, params: unknown, signal?: AbortSignal, headers?: HeaderMap, sessionKey?: string): Promise<any>;
  notify(method: string, params?: unknown): Promise<void>;
  close(): Promise<void>;
}

interface Pending { resolve: (v: any) => void; reject: (e: Error) => void }

function rpcError(error: any, forms: readonly string[] = []): Error {
  return new Error(redact(`MCP error ${error?.code ?? ''}: ${error?.message ?? JSON.stringify(error)}`, forms));
}

class StdioTransport implements Transport {
  private child: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private stderr = '';
  private timeoutMs: number;

  constructor(cfg: McpServerConfig, timeoutMs: number) {
    this.timeoutMs = timeoutMs;
    this.child = spawn(cfg.command!, cfg.args ?? [], { cwd: cfg.cwd, env: mcpChildEnv(cfg), stdio: ['pipe', 'pipe', 'pipe'] });
    const stderrChars = cfg.stderrChars ?? limitDefault('mcp.stderrChars');
    this.child.stderr!.on('data', (d: Buffer) => (this.stderr = stderrChars ? (this.stderr + d.toString()).slice(-stderrChars) : ''));
    createInterface({ input: this.child.stdout! }).on('line', (line) => this.onLine(line));
    const fail = (why: string) => {
      for (const p of this.pending.values()) p.reject(new Error(`MCP server ${why}${this.stderr ? `: ${this.stderr.trim()}` : ''}`));
      this.pending.clear();
    };
    this.child.on('exit', (code) => fail(`exited with code ${code}`));
    this.child.on('error', (err) => fail(`failed to start (${err.message})`));
  }

  private onLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // non-protocol output
    }
    if (msg.id !== undefined && msg.method) {
      // Server-initiated request: answer ping, decline everything else.
      const reply = msg.method === 'ping' ? { result: {} } : { error: { code: -32601, message: 'method not supported by client' } };
      this.write({ jsonrpc: '2.0', id: msg.id, ...reply });
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(rpcError(msg.error));
    else p.resolve(msg.result);
  }

  private write(msg: unknown): void {
    this.child.stdin!.write(`${JSON.stringify(msg)}\n`);
  }

  request(method: string, params: unknown, signal?: AbortSignal): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const ms = finiteTimeout(this.timeoutMs);
      const timer = ms === undefined ? undefined : setTimeout(() => done(new Error(`MCP ${method} timed out after ${ms}ms`)), ms);
      const onAbort = () => {
        this.write({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } });
        done(new Error(`MCP ${method} aborted`));
      };
      const done = (err?: Error, value?: unknown) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.pending.delete(id);
        err ? reject(err) : resolve(value);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, { resolve: (v) => done(undefined, v), reject: (e) => done(e) });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    this.write({ jsonrpc: '2.0', method, ...(params !== undefined && { params }) });
  }

  async close(): Promise<void> {
    this.child.stdin?.end();
    this.child.kill();
  }
}

/** An MCP session: the server's id, once it has assigned one. */
interface Session { id?: string }

function initializeParams() {
  return { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'reinloop', version: VERSION } };
}

class HttpTransport implements Transport {
  private nextId = 1;
  /** The connection's own session (initialize, tools/list, calls without identity). */
  private main: Session = {};
  /** One session per identity, least recently used first; each response only updates the session of its own caller. */
  private sessions = new Map<string, { session: Session; ready: Promise<void> }>();
  private maxSessions: number;
  private protocol?: string;
  private cfg: McpServerConfig;
  private timeoutMs: number;
  private connectHeaders: () => Promise<HeaderMap | undefined>;
  private minSecretChars?: number;

  constructor(cfg: McpServerConfig, timeoutMs: number, connectHeaders: () => Promise<HeaderMap | undefined> = async () => undefined, minSecretChars?: number) {
    this.maxSessions = cfg.maxSessions ?? limitDefault('mcp.maxSessions');
    this.cfg = cfg;
    this.timeoutMs = timeoutMs;
    this.connectHeaders = connectHeaders;
    this.minSecretChars = minSecretChars;
  }

  setProtocol(version: string): void {
    this.protocol = version;
  }

  /** Static header values and the active credential: a server error body may echo them. */
  private secrets(auth: HeaderMap | undefined): string[] {
    return secretForms([...staticSecrets(this.cfg.headers), ...staticSecrets(auth)], this.minSecretChars);
  }

  /** Never follows a redirect: static headers and credentials must not be resent to another location. */
  private async fetch(init: RequestInit): Promise<Response> {
    try {
      return await fetch(this.cfg.url!, { ...init, redirect: 'error' });
    } catch (err) {
      const cause = (err as { cause?: { message?: string } } | undefined)?.cause?.message ?? '';
      if (/redirect/i.test(cause)) throw new Error('MCP HTTP request was redirected; redirects are not followed, set "url" to the final location');
      throw err;
    }
  }

  private async post(body: unknown, signal?: AbortSignal, headers?: HeaderMap, session: Session = this.main): Promise<{ res: Response; auth: HeaderMap | undefined }> {
    const auth = headers ?? (await this.connectHeaders());
    const res = await this.fetch({
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(session.id && { 'mcp-session-id': session.id }),
        ...(this.protocol && { 'mcp-protocol-version': this.protocol }),
        ...withAuth(this.cfg.headers, auth),
      },
      body: JSON.stringify(body),
      signal: withTimeout(signal, this.timeoutMs),
    });
    session.id = res.headers.get('mcp-session-id') ?? session.id;
    // Mask the whole body before cutting it: a secret that straddles the cut would otherwise survive in part.
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${redact(await res.text().catch(() => ''), this.secrets(auth)).slice(0, this.cfg.errorBodyChars ?? limitDefault('mcp.errorBodyChars'))}`);
    return { res, auth };
  }

  /** The session of `key`, initialized with the caller's own credentials on first use. */
  private async sessionFor(key: string, headers: HeaderMap | undefined, signal?: AbortSignal): Promise<Session> {
    let entry = this.sessions.get(key);
    if (entry) {
      this.sessions.delete(key); // re-insert: most recently used last
    } else {
      const session: Session = {};
      const ready = this.exchange('initialize', initializeParams(), signal, headers, session).then(async () => {
        const { res } = await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, signal, headers, session);
        await res.body?.cancel();
      });
      entry = { session, ready };
      ready.catch(() => this.sessions.get(key) === entry && this.sessions.delete(key));
    }
    this.sessions.set(key, entry);
    while (this.sessions.size > this.maxSessions) this.sessions.delete(this.sessions.keys().next().value!);
    await entry.ready;
    return entry.session;
  }

  async request(method: string, params: unknown, signal?: AbortSignal, headers?: HeaderMap, sessionKey?: string): Promise<any> {
    const session = sessionKey === undefined ? this.main : await this.sessionFor(sessionKey, headers, signal);
    return this.exchange(method, params, signal, headers, session);
  }

  private async exchange(method: string, params: unknown, signal: AbortSignal | undefined, headers: HeaderMap | undefined, session: Session): Promise<any> {
    const id = this.nextId++;
    const { res, auth } = await this.post({ jsonrpc: '2.0', id, method, params }, signal, headers, session);
    const pick = (msg: any) => {
      if (msg.error) throw rpcError(msg.error, this.secrets(auth));
      return msg.result;
    };
    if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
      for await (const ev of readSse(res)) {
        const msg = JSON.parse(ev.data);
        if (msg.id === id) return pick(msg);
      }
      throw new Error(`MCP ${method}: stream ended without a response`);
    }
    return pick(await res.json());
  }

  async notify(method: string, params?: unknown): Promise<void> {
    const { res } = await this.post({ jsonrpc: '2.0', method, ...(params !== undefined && { params }) });
    await res.body?.cancel();
  }

  async close(): Promise<void> {
    // Per-identity sessions cannot be closed here: that needs the identity's own credentials, which are not kept.
    this.sessions.clear();
    if (!this.main.id) return;
    const auth = await this.connectHeaders().catch(() => undefined);
    await this.fetch({ method: 'DELETE', headers: { 'mcp-session-id': this.main.id, ...withAuth(this.cfg.headers, auth) } }).catch(() => {});
  }
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

export class McpClient {
  readonly name: string;
  readonly serverInfo: unknown;
  private transport: Transport;

  private constructor(name: string, transport: Transport, serverInfo: unknown) {
    this.name = name;
    this.transport = transport;
    this.serverInfo = serverInfo;
  }

  static async connect(name: string, cfg: McpServerConfig, opts: McpConnectOptions = {}): Promise<McpClient> {
    const timeoutMs = cfg.timeoutMs ?? limitDefault('mcp.timeoutMs');
    if (!cfg.command === !cfg.url) throw new Error(`MCP server "${name}": set exactly one of "command" or "url"`);
    if (cfg.auth && !cfg.url) throw new Error(`MCP server "${name}": "auth" needs the streamable HTTP transport ("url")`);
    const connectHeaders = async () => (cfg.auth && opts.credentials ? bearer(await opts.credentials.token(cfg.auth.audience, { scopes: cfg.auth.scopes })) : undefined);
    const transport = cfg.command ? new StdioTransport(cfg, timeoutMs) : new HttpTransport(cfg, timeoutMs, connectHeaders, opts.minSecretChars);
    try {
      const init = await transport.request('initialize', initializeParams());
      if (transport instanceof HttpTransport) transport.setProtocol(init?.protocolVersion ?? MCP_PROTOCOL_VERSION);
      await transport.notify('notifications/initialized');
      return new McpClient(name, transport, init?.serverInfo);
    } catch (err) {
      await transport.close();
      throw err;
    }
  }

  async listTools(): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.transport.request('tools/list', cursor ? { cursor } : {});
      tools.push(...(page?.tools ?? []));
      cursor = page?.nextCursor;
    } while (cursor);
    return tools;
  }

  /**
   * `headers` (HTTP transport) replace the connection credentials for this call, e.g. a per-run Authorization.
   * `sessionKey` runs the call in the MCP session of that caller (opened on first use), not in the connection's.
   */
  async callTool(name: string, args: unknown, signal?: AbortSignal, headers?: HeaderMap, sessionKey?: string): Promise<{ content: string; isError: boolean }> {
    const res = await this.transport.request('tools/call', { name, arguments: args ?? {} }, signal, headers, sessionKey);
    const text = (res?.content ?? [])
      .map((c: any) => (c.type === 'text' ? c.text : c.type === 'resource' ? (c.resource?.text ?? `[resource ${c.resource?.uri}]`) : `[${c.type}]`))
      .join('\n');
    const content = text || (res?.structuredContent !== undefined ? JSON.stringify(res.structuredContent) : '');
    return { content, isError: Boolean(res?.isError) };
  }

  close(): Promise<void> {
    return this.transport.close();
  }
}

const bearer = (token: string): HeaderMap => ({ authorization: `Bearer ${token}` });

function riskOf(info: McpToolInfo, forced?: Risk, readOnly?: RegExp[]): Risk {
  if (forced) return forced;
  if (readOnly?.some((r) => r.test(info.name))) return 'read';
  if (info.annotations?.readOnlyHint) return 'read';
  if (info.annotations?.destructiveHint === false) return 'write';
  return 'exec';
}

/** Connects to an MCP server and adapts its tools, namespaced as `<prefix>__<tool>` unless `prefix` is `false` or `''`. */
export async function mcpTools(name: string, cfg: McpServerConfig, opts: McpConnectOptions = {}): Promise<{ client: McpClient; tools: Tool[] }> {
  const client = await McpClient.connect(name, cfg, opts);
  const { auth } = cfg;
  // With `auth`, each call carries a token for the server's audience from the run's credentials; no credentials, no call.
  const callHeaders = async (credentials: CredentialProvider | undefined, signal: AbortSignal): Promise<HeaderMap | undefined> => {
    if (!auth) return undefined;
    if (!credentials) throw new Error(`MCP server "${name}" requires credentials for audience "${auth.audience}", but the run has none`);
    return bearer(await credentials.token(auth.audience, { scopes: auth.scopes, signal }));
  };
  const include = cfg.include?.map(globToRegExp);
  const exclude = cfg.exclude?.map(globToRegExp);
  const readOnly = cfg.readOnly?.map(globToRegExp);
  const prefix = cfg.prefix ?? name;
  const tools = (await client.listTools())
    .filter((t) => (!include || include.some((r) => r.test(t.name))) && !exclude?.some((r) => r.test(t.name)))
    .map((info) =>
      defineTool({
        name: safeToolName(prefix ? `${prefix}__${info.name}` : info.name),
        description: info.description ?? info.name,
        schema: info.inputSchema ?? { type: 'object', properties: {} },
        risk: riskOf(info, cfg.risk, readOnly),
        run: async (args, ctx) => {
          const headers = await callHeaders(ctx.credentials, ctx.signal);
          // A server may echo request headers back; the per-call token and the static header secrets must not reach the
          // model, in a result or in an error. Structured content is used as text only when there is none, so the same
          // masking covers it.
          const token = headers?.authorization?.replace(/^Bearer /, '');
          const forms = secretForms([...(token ? [token] : []), ...staticSecrets(cfg.headers)], opts.minSecretChars);
          try {
            // The session follows the identity, never the raw token (tokens rotate and must not be kept). Without an identity
            // it follows a digest of the token, so two principals never share a session (the connection's session is never used).
            const sessionKey = !headers ? undefined : ctx.identity ? `${ctx.identity.kind}:${ctx.identity.subject}` : `token:${createHash('sha256').update(`${auth!.audience}\0${token}`).digest('hex')}`;
            const res = await client.callTool(info.name, args, ctx.signal, headers, sessionKey);
            return { ...res, content: redact(res.content, forms) };
          } catch (err) {
            throw scrubError(err, forms);
          }
        },
      }),
    );
  return { client, tools };
}
