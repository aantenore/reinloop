import { interpolate } from '../config/load.ts';
import type { JsonSchema, Risk, Tool, ToolOutput } from '../types.ts';
import { defineTool } from './define.ts';

type Env = Record<string, string | undefined>;

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';

const METHODS: readonly string[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];
const PLACEHOLDER = /\{([A-Za-z0-9_.-]+)\}/g;
const TEXTUAL = /^(text\/|application\/(json|xml|yaml|javascript|x-www-form-urlencoded)|[^;]*\+(json|xml))/i;

export interface HttpToolAuth {
  /** Audience of the access token requested from the run's `CredentialProvider`. */
  audience: string;
  scopes?: string[];
}

export interface HttpToolOptions {
  name: string;
  description: string;
  method: HttpMethod;
  /** Absolute URL; `{param}` placeholders are filled from the arguments, URL-encoded. `${env:NAME}` is resolved when the tool is built. */
  url: string;
  /** Arguments sent as query parameters (arrays repeat the key). */
  query?: string[];
  /** Arguments sent as request headers (same name). */
  headerArgs?: string[];
  /** Static headers; `${env:NAME}` is resolved when the tool is built. */
  headers?: Record<string, string>;
  /** `json`: arguments not used above are sent as the JSON body (or only `bodyArg`). Default `none`. */
  body?: 'json' | 'none';
  /** With `body: 'json'`: the argument that holds the whole body. */
  bodyArg?: string;
  schema: JsonSchema;
  /** Default: `read` for GET and HEAD, `write` otherwise. */
  risk?: Risk;
  timeoutMs?: number;
  /** Response text cap (default 16000). */
  maxResultChars?: number;
  /** Send `Authorization: Bearer <token>` from the run's credentials; without credentials the call fails and nothing is sent. */
  auth?: HttpToolAuth;
  env?: Env;
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
const truncate = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max)}…`);
const error = (content: string): ToolOutput => ({ content, isError: true });

function plain(value: unknown): string {
  return typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
}

/** Declarative HTTP tool: one request per call, built from the arguments. Non-2xx answers become tool errors. */
export function httpTool(opts: HttpToolOptions): Tool {
  const method = opts.method.toUpperCase() as HttpMethod;
  if (!METHODS.includes(method)) throw new Error(`httpTool "${opts.name}": unsupported method "${opts.method}" (use ${METHODS.join(', ')})`);
  const body = opts.body ?? 'none';
  if (body === 'json' && (method === 'GET' || method === 'HEAD')) throw new Error(`httpTool "${opts.name}": ${method} cannot have a body`);
  if (opts.bodyArg && body !== 'json') throw new Error(`httpTool "${opts.name}": bodyArg needs body "json"`);
  const env = opts.env ?? process.env;
  const url = interpolate(opts.url, env, `httpTool ${opts.name}.url`);
  const staticHeaders = interpolate(opts.headers ?? {}, env, `httpTool ${opts.name}.headers`);
  const pathArgs = [...url.matchAll(PLACEHOLDER)].map((m) => m[1]!);
  const queryArgs = opts.query ?? [];
  const headerArgs = opts.headerArgs ?? [];
  const consumed = new Set([...pathArgs, ...queryArgs, ...headerArgs]);
  const maxChars = opts.maxResultChars ?? 16_000;
  const readOnly = method === 'GET' || method === 'HEAD';

  return defineTool({
    name: opts.name,
    description: opts.description,
    schema: opts.schema,
    risk: opts.risk ?? (readOnly ? 'read' : 'write'),
    layer: 'tool',
    ...(opts.timeoutMs && { timeoutMs: opts.timeoutMs }),
    async run(args: Record<string, unknown> = {}, ctx) {
      const headers = new Headers(staticHeaders);
      for (const h of headerArgs) if (args[h] !== undefined && args[h] !== null) headers.set(h, plain(args[h]));

      const missing: string[] = [];
      const target = new URL(
        url.replace(PLACEHOLDER, (_, key: string) => {
          if (args[key] === undefined || args[key] === null) missing.push(key);
          return encodeURIComponent(plain(args[key] ?? ''));
        }),
      );
      if (missing.length) return error(`Missing path parameter(s): ${missing.join(', ')}`);
      for (const key of queryArgs) {
        const value = args[key];
        if (value === undefined || value === null) continue;
        for (const v of Array.isArray(value) ? value : [value]) target.searchParams.append(key, plain(v));
      }

      let init: RequestInit = { method, headers };
      if (body === 'json') {
        const payload = opts.bodyArg ? args[opts.bodyArg] : Object.fromEntries(Object.entries(args).filter(([k, v]) => !consumed.has(k) && v !== undefined));
        if (payload !== undefined) {
          headers.set('content-type', 'application/json');
          init = { ...init, body: JSON.stringify(payload) };
        }
      }
      if (!headers.has('accept')) headers.set('accept', 'application/json, text/plain;q=0.9, */*;q=0.5');

      let token: string | undefined;
      if (opts.auth) {
        if (!ctx.credentials) return error(`${opts.name} needs credentials for audience "${opts.auth.audience}" and this run has none; the request was not sent`);
        try {
          token = await ctx.credentials.token(opts.auth.audience, { scopes: opts.auth.scopes, signal: ctx.signal });
        } catch (err) {
          return error(`Could not get a token for audience "${opts.auth.audience}": ${errorMessage(err)}; the request was not sent`);
        }
        headers.set('authorization', `Bearer ${token}`);
      }

      const res = await fetch(target, { ...init, signal: ctx.signal });
      const type = res.headers.get('content-type') ?? '';
      if (res.status >= 200 && res.status < 300 && type && !TEXTUAL.test(type)) {
        return `HTTP ${res.status}: ${(await res.arrayBuffer()).byteLength} bytes of ${type.split(';')[0]} (not shown)`;
      }
      let text = await res.text();
      // A server may echo request headers back; the token must not reach the model.
      if (token) text = text.split(token).join('[redacted]');
      if (!res.ok) return error(`HTTP ${res.status} ${res.statusText}`.trim() + (text ? `: ${truncate(text, 500)}` : ''));
      if (/json/i.test(type) && text) {
        try {
          text = JSON.stringify(JSON.parse(text), null, 2);
        } catch {
          // not valid JSON: keep the raw text
        }
      }
      if (!text) return `HTTP ${res.status} (no content)`;
      return text.length > maxChars ? `${text.slice(0, maxChars)}\n[truncated: ${text.length} chars in total]` : text;
    },
  });
}
