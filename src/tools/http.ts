import { interpolate } from '../config/load.ts';
import { limitDefault } from '../limits.ts';
import type { JsonSchema, Risk, Tool, ToolOutput } from '../types.ts';
import { defineTool } from './define.ts';
import { redact, secretForms, staticSecrets } from './redact.ts';

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
  /** Call time limit (default: the agent's tools.timeoutMs; Infinity: none). */
  timeoutMs?: number;
  /** Response text cap (default 16000; Infinity: none). */
  maxResultChars?: number;
  /** Response text kept in an error result, after masking (default 500). */
  errorBodyChars?: number;
  /** Shorter secrets are not masked (default 4). */
  minSecretChars?: number;
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

/** Fixed part of a URL template: its origin and the path up to the first placeholder. Placeholders may not reach the host. */
function templateGuard(url: string): { origin: string; prefix: string } {
  const at = url.indexOf('{');
  const head = at < 0 ? url : url.slice(0, at);
  const hostError = new Error('placeholders are allowed in the path and query only, not in the scheme or host');
  let parsed: URL;
  try {
    parsed = new URL(head);
  } catch {
    throw hostError;
  }
  if (at >= 0 && /^https?:\/\/[^/?#]*$/i.test(head)) throw hostError;
  return { origin: parsed.origin, prefix: parsed.pathname };
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
  let guard: { origin: string; prefix: string };
  try {
    guard = templateGuard(url);
  } catch (err) {
    throw new Error(`httpTool "${opts.name}": ${errorMessage(err)}`);
  }
  const pathArgs = [...url.matchAll(PLACEHOLDER)].map((m) => m[1]!);
  const queryArgs = opts.query ?? [];
  const headerArgs = opts.headerArgs ?? [];
  const consumed = new Set([...pathArgs, ...queryArgs, ...headerArgs]);
  const maxChars = opts.maxResultChars ?? limitDefault('httpTools.maxResultChars');
  const errorChars = opts.errorBodyChars ?? limitDefault('httpTools.errorBodyChars');
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
      const dotted: string[] = [];
      const target = new URL(
        url.replace(PLACEHOLDER, (_, key: string) => {
          if (args[key] === undefined || args[key] === null) missing.push(key);
          const value = plain(args[key] ?? '');
          // encodeURIComponent keeps dots, and "." / ".." would climb the path once the URL is normalized.
          if (/^\.+$/.test(value)) dotted.push(key);
          return encodeURIComponent(value);
        }),
      );
      if (missing.length) return error(`Missing path parameter(s): ${missing.join(', ')}`);
      if (dotted.length) return error(`Invalid path parameter(s): ${dotted.join(', ')} (a value made only of dots is not allowed); the request was not sent`);
      if (target.origin !== guard.origin || !target.pathname.startsWith(guard.prefix)) return error('The arguments change where the request goes; the request was not sent');
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

      const secrets = [...staticSecrets(staticHeaders), ...headerArgs.flatMap((h) => (args[h] !== undefined && args[h] !== null ? [plain(args[h])] : []))];
      let token: string | undefined;
      if (opts.auth) {
        if (!ctx.credentials) return error(`${opts.name} needs credentials for audience "${opts.auth.audience}" and this run has none; the request was not sent`);
        try {
          token = await ctx.credentials.token(opts.auth.audience, { scopes: opts.auth.scopes, signal: ctx.signal });
        } catch (err) {
          return error(`Could not get a token for audience "${opts.auth.audience}": ${errorMessage(err)}; the request was not sent`);
        }
        headers.set('authorization', `Bearer ${token}`);
        secrets.push(token);
      }

      const res = await fetch(target, { ...init, signal: ctx.signal });
      const type = res.headers.get('content-type') ?? '';
      if (res.status >= 200 && res.status < 300 && type && !TEXTUAL.test(type)) {
        return `HTTP ${res.status}: ${(await res.arrayBuffer()).byteLength} bytes of ${type.split(';')[0]} (not shown)`;
      }
      // A server may echo request headers back; no configured secret may reach the model. Mask the raw body, normalise
      // JSON (which decodes \u escapes), then mask again, so a secret cannot survive in any form.
      const forms = secretForms(secrets, opts.minSecretChars);
      let text = redact(await res.text(), forms);
      const json = /json/i.test(type) && text;
      if (json) {
        try {
          text = redact(JSON.stringify(JSON.parse(text), null, res.ok ? 2 : undefined), forms);
        } catch {
          // not valid JSON: keep the raw text
        }
      }
      if (!res.ok) return error(redact(`HTTP ${res.status} ${res.statusText}`, forms).trim() + (text ? `: ${truncate(text, errorChars)}` : ''));
      if (!text) return `HTTP ${res.status} (no content)`;
      return text.length > maxChars ? `${text.slice(0, maxChars)}\n[truncated: ${text.length} chars in total]` : text;
    },
  });
}
