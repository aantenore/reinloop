import { type ChildProcess, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readSse } from '../providers/http.ts';
import { defineTool, safeToolName } from '../tools/define.ts';
import type { JsonSchema, Risk, Tool } from '../types.ts';
import { globToRegExp } from '../util.ts';

export const MCP_PROTOCOL_VERSION = '2025-06-18';

export interface McpServerConfig {
  /** stdio transport */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Streamable HTTP transport */
  url?: string;
  headers?: Record<string, string>;
  /** Tool name prefix; defaults to the server name. Tools are exposed as `<prefix>__<tool>`. */
  prefix?: string;
  /** Force a risk level for every tool; otherwise derived from MCP tool annotations. */
  risk?: Risk;
  /** Globs of tools known to be read-only when the server does not annotate them (risk "read"). */
  readOnly?: string[];
  include?: string[];
  exclude?: string[];
  timeoutMs?: number;
}

interface Transport {
  request(method: string, params: unknown, signal?: AbortSignal): Promise<any>;
  notify(method: string, params?: unknown): Promise<void>;
  close(): Promise<void>;
}

interface Pending { resolve: (v: any) => void; reject: (e: Error) => void }

function rpcError(error: any): Error {
  return new Error(`MCP error ${error?.code ?? ''}: ${error?.message ?? JSON.stringify(error)}`);
}

class StdioTransport implements Transport {
  private child: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private stderr = '';
  private timeoutMs: number;

  constructor(cfg: McpServerConfig, timeoutMs: number) {
    this.timeoutMs = timeoutMs;
    this.child = spawn(cfg.command!, cfg.args ?? [], { cwd: cfg.cwd, env: { ...process.env, ...cfg.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr!.on('data', (d: Buffer) => (this.stderr = (this.stderr + d.toString()).slice(-2000)));
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
      const timer = setTimeout(() => done(new Error(`MCP ${method} timed out after ${this.timeoutMs}ms`)), this.timeoutMs);
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

class HttpTransport implements Transport {
  private nextId = 1;
  private session?: string;
  private protocol?: string;
  private cfg: McpServerConfig;
  private timeoutMs: number;

  constructor(cfg: McpServerConfig, timeoutMs: number) {
    this.cfg = cfg;
    this.timeoutMs = timeoutMs;
  }

  setProtocol(version: string): void {
    this.protocol = version;
  }

  private async post(body: unknown, signal?: AbortSignal): Promise<Response> {
    const res = await fetch(this.cfg.url!, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(this.session && { 'mcp-session-id': this.session }),
        ...(this.protocol && { 'mcp-protocol-version': this.protocol }),
        ...this.cfg.headers,
      },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs),
    });
    this.session = res.headers.get('mcp-session-id') ?? this.session;
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
    return res;
  }

  async request(method: string, params: unknown, signal?: AbortSignal): Promise<any> {
    const id = this.nextId++;
    const res = await this.post({ jsonrpc: '2.0', id, method, params }, signal);
    const pick = (msg: any) => {
      if (msg.error) throw rpcError(msg.error);
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
    const res = await this.post({ jsonrpc: '2.0', method, ...(params !== undefined && { params }) });
    await res.body?.cancel();
  }

  async close(): Promise<void> {
    if (!this.session) return;
    await fetch(this.cfg.url!, { method: 'DELETE', headers: { 'mcp-session-id': this.session, ...this.cfg.headers } }).catch(() => {});
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

  static async connect(name: string, cfg: McpServerConfig): Promise<McpClient> {
    const timeoutMs = cfg.timeoutMs ?? 60_000;
    if (!cfg.command === !cfg.url) throw new Error(`MCP server "${name}": set exactly one of "command" or "url"`);
    const transport = cfg.command ? new StdioTransport(cfg, timeoutMs) : new HttpTransport(cfg, timeoutMs);
    try {
      const init = await transport.request('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'reinloop', version: '0.1.0' },
      });
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

  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<{ content: string; isError: boolean }> {
    const res = await this.transport.request('tools/call', { name, arguments: args ?? {} }, signal);
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

function riskOf(info: McpToolInfo, forced?: Risk, readOnly?: RegExp[]): Risk {
  if (forced) return forced;
  if (readOnly?.some((r) => r.test(info.name))) return 'read';
  if (info.annotations?.readOnlyHint) return 'read';
  if (info.annotations?.destructiveHint === false) return 'write';
  return 'exec';
}

/** Connects to an MCP server and adapts its tools, namespaced as `<prefix>__<tool>`. */
export async function mcpTools(name: string, cfg: McpServerConfig): Promise<{ client: McpClient; tools: Tool[] }> {
  const client = await McpClient.connect(name, cfg);
  const include = cfg.include?.map(globToRegExp);
  const exclude = cfg.exclude?.map(globToRegExp);
  const readOnly = cfg.readOnly?.map(globToRegExp);
  const prefix = cfg.prefix ?? name;
  const tools = (await client.listTools())
    .filter((t) => (!include || include.some((r) => r.test(t.name))) && !exclude?.some((r) => r.test(t.name)))
    .map((info) =>
      defineTool({
        name: safeToolName(`${prefix}__${info.name}`),
        description: info.description ?? info.name,
        schema: info.inputSchema ?? { type: 'object', properties: {} },
        risk: riskOf(info, cfg.risk, readOnly),
        run: (args, ctx) => client.callTool(info.name, args, ctx.signal),
      }),
    );
  return { client, tools };
}
