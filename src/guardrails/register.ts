import { ConfigError, interpolate } from '../config/load.ts';
import type { Registry } from '../registry.ts';
import type { Guard } from '../types.ts';
import { httpGuard } from './http.ts';
import { llmGuardGuard } from './llm-guard.ts';
import { guardMiddleware } from './middleware.ts';
import { presidioGuard } from './presidio.ts';
import { regexGuard } from './regex.ts';

/**
 * Registers the built-in guard types (`presidio`, `llm-guard`, `http`, `regex`) in `registry.guards` and the `guard`
 * middleware, which builds its guards from the top-level `guardrails` config. Plugins add types to `registry.guards`
 * (NeMo Guardrails, Guardrails AI, Granite Guardian, ...). Agents opt in with `middleware: [guard]`.
 */
export function registerGuardrails(r: Registry): void {
  r.guards.set('presidio', (o) => presidioGuard(o as Parameters<typeof presidioGuard>[0]));
  r.guards.set('llm-guard', (o) => llmGuardGuard(o as Parameters<typeof llmGuardGuard>[0]));
  r.guards.set('http', (o) => httpGuard(o as Parameters<typeof httpGuard>[0]));
  r.guards.set('regex', (o) => regexGuard(o as Parameters<typeof regexGuard>[0]));

  r.middleware.set('guard', (_o, ctx) =>
    ctx.once('guardrails', async () => {
      const cfg = ctx.config.guardrails;
      if (!cfg) throw new ConfigError('middleware "guard" needs a top-level "guardrails" config ({ guards: [...] })');
      const { guards: specs, onError, name } = interpolate(cfg, ctx.env, '$.guardrails');
      const guards: Guard[] = await Promise.all(
        specs.map((spec, i) => {
          const factory = r.guards.get(spec.type);
          if (!factory) throw new ConfigError(`$.guardrails.guards[${i}].type: unknown guard "${spec.type}" (registered: ${[...r.guards.keys()].join(', ')})`);
          const { type: _, ...options } = spec;
          return factory(options, ctx);
        }),
      );
      return guardMiddleware(guards, { onError, name });
    }),
  );
}
