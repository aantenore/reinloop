import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { limitDefault } from '../limits.ts';
import type { JsonSchema, Risk, Tool } from '../types.ts';
import { safeToolName } from './define.ts';
import { type HttpMethod, httpTool, type HttpToolAuth } from './http.ts';

type Env = Record<string, string | undefined>;

const truncate = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max)}…`);
const globToRegExp = (glob: string) => new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);

export type OpenApiDocument = { openapi?: string; [key: string]: any };

export interface OpenApiOptions {
  /** Server the operations are called on (default: the first of the spec's `servers`). */
  baseUrl?: string;
  /** Globs of operationIds to import (default: all). */
  include?: string[];
  /** Tool name prefix; tools are named `<prefix>__<operationId>`. */
  prefix?: string;
  /** Default: `read` for GET and HEAD, `write` otherwise. */
  risk?: (method: string) => Risk;
  /** Bearer token from the run's credentials for every operation. */
  auth?: HttpToolAuth;
  /** Static headers sent with every call; `${env:NAME}` works. */
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxResultChars?: number;
  /** Response text kept in an error result (default 500). */
  errorBodyChars?: number;
  /** Shorter secrets are not masked (default 4). */
  minSecretChars?: number;
  /** Nested `$ref` levels inlined (default 24). */
  maxRefDepth?: number;
  /** Characters of the operation summary used as tool description (default 1000). */
  descriptionChars?: number;
  env?: Env;
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head'] as const;
/** Headers OpenAPI defines as handled by the transport, not as parameters. */
const RESERVED_HEADERS = new Set(['accept', 'content-type', 'authorization']);

function pointer(spec: OpenApiDocument, ref: string): unknown {
  if (!ref.startsWith('#/')) throw new Error(`unsupported $ref "${ref}" (only local "#/..." references are resolved)`);
  let node: any = spec;
  for (const part of ref.slice(2).split('/')) {
    node = node?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
    if (node === undefined) throw new Error(`unresolved $ref "${ref}"`);
  }
  return node;
}

/** Inlines local `$ref`s; a reference that points back into itself is cut to an unconstrained schema. */
function deref(spec: OpenApiDocument, node: unknown, stack: string[] = [], maxDepth: number = limitDefault('openapi.maxRefDepth')): any {
  if (Array.isArray(node)) return node.map((n) => deref(spec, n, stack, maxDepth));
  if (typeof node !== 'object' || node === null) return node;
  const obj = node as Record<string, unknown>;
  if (typeof obj.$ref === 'string') {
    if (stack.includes(obj.$ref) || stack.length > maxDepth) return {};
    return deref(spec, pointer(spec, obj.$ref), [...stack, obj.$ref], maxDepth);
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = deref(spec, v, stack, maxDepth);
  // OpenAPI 3.0 `nullable` -> JSON Schema type union.
  if (out.nullable === true && typeof out.type === 'string') out.type = [out.type, 'null'];
  delete out.nullable;
  return out;
}

function serverUrl(spec: OpenApiDocument): string | undefined {
  const server = spec.servers?.[0];
  if (!server?.url) return undefined;
  return String(server.url).replace(/\{([^}]+)\}/g, (_, v: string) => String(server.variables?.[v]?.default ?? ''));
}

const jsonContent = (content: Record<string, any> | undefined) => {
  const key = Object.keys(content ?? {}).find((k) => /^application\/(.+\+)?json(;|$)/i.test(k) || k === '*/*');
  return key ? content![key] : undefined;
};

/** Builds tools from an OpenAPI 3 document (already parsed). Operations with a non-JSON request body are skipped. */
export function openapiTools(spec: OpenApiDocument, opts: OpenApiOptions = {}): Tool[] {
  if (typeof spec?.openapi !== 'string' || !spec.openapi.startsWith('3')) {
    throw new Error('not an OpenAPI 3 document (missing "openapi: 3.x"; Swagger 2 is not supported)');
  }
  const base = (opts.baseUrl ?? serverUrl(spec))?.replace(/\/+$/, '');
  if (!base || !/^https?:\/\/[^/?#\s]+/i.test(base)) throw new Error('OpenAPI: set an absolute "baseUrl" (the spec has no usable absolute "servers" entry)');
  const include = opts.include?.map(globToRegExp);
  const tools: Tool[] = [];
  const used = new Set<string>();

  for (const [path, rawItem] of Object.entries<any>(spec.paths ?? {})) {
    const item = deref(spec, rawItem, [], opts.maxRefDepth);
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!op) continue;
      const operationId: string = op.operationId ?? `${method}_${path.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '')}`;
      if (include && !include.some((r) => r.test(operationId))) continue;

      const params = new Map<string, any>();
      for (const p of [...(item.parameters ?? []), ...(op.parameters ?? [])]) if (['path', 'query', 'header'].includes(p.in)) params.set(`${p.in}:${p.name}`, p);
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      const query: string[] = [];
      const headerArgs: string[] = [];
      for (const p of params.values()) {
        if (p.in === 'header' && RESERVED_HEADERS.has(String(p.name).toLowerCase())) continue;
        if (properties[p.name]) throw new Error(`OpenAPI operation "${operationId}": parameter "${p.name}" is declared in more than one location; exclude it with "include"`);
        properties[p.name] = { ...(p.schema ?? {}), ...(p.description && { description: p.description }) };
        if (p.in === 'path' || p.required) required.push(p.name);
        if (p.in === 'query') query.push(p.name);
        if (p.in === 'header') headerArgs.push(p.name);
      }

      let bodyArg: string | undefined;
      const hasBody = op.requestBody !== undefined;
      if (hasBody) {
        const media = jsonContent(op.requestBody.content);
        if (!media) continue;
        const schema = media.schema ?? {};
        const keys = schema.type === 'object' && schema.properties ? Object.keys(schema.properties) : [];
        if (keys.length && keys.every((k) => !properties[k])) {
          Object.assign(properties, schema.properties);
          if (op.requestBody.required) required.push(...((schema.required as string[] | undefined) ?? []));
        } else {
          bodyArg = 'body';
          properties.body = { ...schema, ...(op.requestBody.description && !schema.description && { description: op.requestBody.description }) };
          if (op.requestBody.required) required.push('body');
        }
      }

      let name = safeToolName(opts.prefix ? `${opts.prefix}__${operationId}` : operationId);
      for (let n = 2; used.has(name); n++) name = safeToolName(`${name.slice(0, 60)}_${n}`);
      used.add(name);
      const description = [op.summary, op.description].filter(Boolean).join(': ') || `${method.toUpperCase()} ${path}`;
      tools.push(
        httpTool({
          name,
          description: truncate(description, opts.descriptionChars ?? limitDefault('openapi.descriptionChars')),
          method: method.toUpperCase() as HttpMethod,
          url: `${base}${path}`,
          query,
          headerArgs,
          headers: opts.headers,
          body: hasBody ? 'json' : 'none',
          ...(bodyArg && { bodyArg }),
          schema: { type: 'object', properties, required, additionalProperties: false },
          risk: opts.risk ? opts.risk(method.toUpperCase()) : method === 'get' || method === 'head' ? 'read' : 'write',
          timeoutMs: opts.timeoutMs,
          maxResultChars: opts.maxResultChars,
          errorBodyChars: opts.errorBodyChars,
          minSecretChars: opts.minSecretChars,
          auth: opts.auth,
          env: opts.env,
        }),
      );
    }
  }
  return tools;
}

export interface LoadedOpenApi { spec: OpenApiDocument; url?: string }

/** Reads an OpenAPI 3 document from a file path (relative to `baseDir`) or an http(s) URL. JSON only. */
export async function readOpenApiSpec(source: string, baseDir: string = process.cwd(), opts: { timeoutMs?: number } = {}): Promise<LoadedOpenApi> {
  const isUrl = /^https?:\/\//i.test(source);
  let text: string;
  if (isUrl) {
    const res = await fetch(source, { signal: AbortSignal.timeout(opts.timeoutMs ?? limitDefault('openapi.specTimeoutMs')) });
    if (!res.ok) throw new Error(`cannot fetch OpenAPI spec ${source}: HTTP ${res.status}`);
    text = await res.text();
  } else {
    text = await readFile(resolve(baseDir, source), 'utf8');
  }
  try {
    return { spec: JSON.parse(text), ...(isUrl && { url: source }) };
  } catch {
    throw new Error(`OpenAPI spec ${source} is not valid JSON (YAML is not supported: convert it to JSON first)`);
  }
}

/** Resolves a relative `servers` entry against the URL the spec was fetched from. */
export function specBaseUrl(spec: OpenApiDocument, specUrl?: string): string | undefined {
  const url = serverUrl(spec);
  if (url === undefined || /^https?:\/\//i.test(url) || !specUrl) return undefined;
  return new URL(url, specUrl).href;
}
