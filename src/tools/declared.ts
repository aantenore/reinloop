import { ConfigError, type Env, type HarnessConfig, interpolate } from '../config/load.ts';
import type { Tool } from '../types.ts';
import { errorMessage, globToRegExp } from '../util.ts';
import { httpTool } from './http.ts';
import { openapiTools, readOpenApiSpec, specBaseUrl } from './openapi.ts';

export interface DeclaredTools {
  /** `httpTools` entries whose name matches the glob. */
  http(pattern: string): Tool[];
  /**
   * Tools of an `openapi` source, for `<source>__<operationId>` globs or `openapi:<source>`; `undefined` when the pattern
   * does not name a source. Specs are loaded on first use.
   */
  openapi(pattern: string, owner: string): Promise<Tool[] | undefined>;
}

/** Tools declared in the config (`httpTools`, `openapi`), built once and shared. */
export function declaredTools(config: HarnessConfig, env: Env, baseDir: string): DeclaredTools {
  const http = new Map<string, Tool>();
  const specs = new Map<string, Promise<Tool[]>>();
  const sources = Object.keys(config.openapi ?? {});

  const load = (name: string): Promise<Tool[]> => {
    if (!specs.has(name)) {
      const path = `$.openapi.${name}`;
      specs.set(
        name,
        (async () => {
          const def = config.openapi![name]!;
          try {
            const { spec, url } = await readOpenApiSpec(interpolate(def.spec, env, `${path}.spec`), baseDir);
            const baseUrl = def.baseUrl === undefined ? specBaseUrl(spec, url) : interpolate(def.baseUrl, env, `${path}.baseUrl`);
            return openapiTools(spec, {
              prefix: name, baseUrl, include: def.include, auth: def.auth, headers: def.headers,
              timeoutMs: def.timeoutMs, maxResultChars: def.maxResultChars, env,
            });
          } catch (err) {
            if (err instanceof ConfigError) throw err;
            throw new ConfigError(`${path}: ${errorMessage(err)}`);
          }
        })(),
      );
      specs.get(name)!.catch(() => specs.delete(name));
    }
    return specs.get(name)!;
  };

  return {
    http(pattern) {
      const re = globToRegExp(pattern);
      const hits: Tool[] = [];
      for (const [name, def] of Object.entries(config.httpTools ?? {})) {
        if (!re.test(name)) continue;
        if (!http.has(name)) {
          try {
            http.set(name, httpTool({ ...def, name, env }));
          } catch (err) {
            throw new ConfigError(`$.httpTools.${name}: ${errorMessage(err)}`);
          }
        }
        hits.push(http.get(name)!);
      }
      return hits;
    },
    async openapi(pattern, owner) {
      const explicit = pattern.startsWith('openapi:');
      const name = explicit ? pattern.slice(8) : sources.filter((s) => pattern.startsWith(`${s}__`)).sort((a, b) => b.length - a.length)[0];
      if (name === undefined) return undefined;
      if (!config.openapi?.[name]) throw new ConfigError(`$.agents.${owner}.tools: unknown OpenAPI source "${name}"`);
      const all = await load(name);
      const re = explicit ? /.*/ : globToRegExp(pattern);
      const hits = all.filter((t) => re.test(t.name));
      if (!hits.length) throw new ConfigError(`$.agents.${owner}.tools: "${pattern}" matches no tool of OpenAPI source "${name}"`);
      return hits;
    },
  };
}
