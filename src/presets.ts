import { anthropic } from './providers/anthropic.ts';
import { pricingFor } from './pricing.ts';
import { mockProvider } from './providers/mock.ts';
import { openaiCompatible } from './providers/openai.ts';
import { withRetry } from './providers/resilient.ts';
import type { ModelRef, Provider } from './types.ts';

export type Env = Record<string, string | undefined>;

export interface ProviderPreset {
  kind: 'openai-compatible' | 'anthropic' | 'mock';
  baseUrl?: string;
  /** Env var that overrides baseUrl. */
  baseUrlEnv?: string;
  /** Env var holding the API key. */
  apiKeyEnv?: string;
  /** Request headers taken from env vars when set: header name -> env var name. */
  headerEnv?: Record<string, string>;
  options?: Record<string, unknown>;
}

/** Per-preset settings from config (`presets.<name>`). */
export interface PresetOverrides {
  /** Extra request headers, applied over those from `headerEnv`. */
  headers?: Record<string, string>;
}

/** Well-known providers usable as `"<preset>/<model>"` with zero configuration. */
export const PRESETS: Record<string, ProviderPreset> = {
  openai: { kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', baseUrlEnv: 'OPENAI_BASE_URL', apiKeyEnv: 'OPENAI_API_KEY', options: { maxTokensParam: 'max_completion_tokens' } },
  anthropic: {
    kind: 'anthropic', baseUrlEnv: 'ANTHROPIC_BASE_URL', apiKeyEnv: 'ANTHROPIC_API_KEY',
    headerEnv: { 'anthropic-workspace-id': 'ANTHROPIC_WORKSPACE_ID' }, options: { cache: true },
  },
  gemini: { kind: 'openai-compatible', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKeyEnv: 'GEMINI_API_KEY' },
  openrouter: { kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY' },
  groq: { kind: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1', apiKeyEnv: 'GROQ_API_KEY' },
  mistral: { kind: 'openai-compatible', baseUrl: 'https://api.mistral.ai/v1', apiKeyEnv: 'MISTRAL_API_KEY' },
  deepseek: { kind: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1', apiKeyEnv: 'DEEPSEEK_API_KEY' },
  xai: { kind: 'openai-compatible', baseUrl: 'https://api.x.ai/v1', apiKeyEnv: 'XAI_API_KEY' },
  together: { kind: 'openai-compatible', baseUrl: 'https://api.together.xyz/v1', apiKeyEnv: 'TOGETHER_API_KEY' },
  // Local servers enforce schemas with a grammar that leaves no room for tool calls.
  ollama: { kind: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', baseUrlEnv: 'OLLAMA_BASE_URL', options: { structuredOutput: 'without-tools' } },
  lmstudio: { kind: 'openai-compatible', baseUrl: 'http://localhost:1234/v1', baseUrlEnv: 'LMSTUDIO_BASE_URL', options: { structuredOutput: 'without-tools' } },
  vllm: { kind: 'openai-compatible', baseUrl: 'http://localhost:8000/v1', baseUrlEnv: 'VLLM_BASE_URL', apiKeyEnv: 'VLLM_API_KEY', options: { structuredOutput: 'without-tools' } },
  mock: { kind: 'mock' },
};

/** Short names accepted in agent files (compatible with common agent-file conventions). */
export const MODEL_ALIASES: Record<string, string> = {
  sonnet: 'anthropic/claude-sonnet-5-5',
  opus: 'anthropic/claude-opus-5-5',
  haiku: 'anthropic/claude-haiku-5-5',
};

/**
 * Model used when an agent does not name one: `REINLOOP_MODEL`, else the first provider
 * with a configured key, else a local Ollama model.
 */
export function defaultModel(env: Env = process.env): string {
  if (env.REINLOOP_MODEL) return env.REINLOOP_MODEL;
  if (env.ANTHROPIC_API_KEY) return 'anthropic/claude-sonnet-5-5';
  if (env.OPENAI_API_KEY) return 'openai/gpt-5-mini';
  if (env.OPENROUTER_API_KEY) return 'openrouter/openai/gpt-5-mini';
  if (env.GEMINI_API_KEY) return 'gemini/gemini-2.5-flash';
  return 'ollama/qwen3:8b';
}

export function presetProvider(name: string, env: Env = process.env, overrides: PresetOverrides = {}): Provider {
  const preset = PRESETS[name];
  if (!preset) throw new Error(`unknown provider "${name}" (built-in: ${Object.keys(PRESETS).join(', ')}; or define it under "providers")`);
  if (preset.kind === 'mock') return mockProvider();
  const baseUrl = (preset.baseUrlEnv && env[preset.baseUrlEnv]) || preset.baseUrl;
  const apiKey = preset.apiKeyEnv ? env[preset.apiKeyEnv] : undefined;
  const headers: Record<string, string> = { ...(preset.options?.headers as Record<string, string> | undefined) };
  for (const [header, envVar] of Object.entries(preset.headerEnv ?? {})) if (env[envVar]) headers[header] = env[envVar];
  Object.assign(headers, overrides.headers);
  const common = { name, baseUrl, apiKey, stream: true, ...preset.options, ...(Object.keys(headers).length && { headers }) };
  return withRetry(preset.kind === 'anthropic' ? anthropic(common) : openaiCompatible(common));
}

/** Splits `"provider/model"`; the model part may itself contain slashes (e.g. OpenRouter ids). */
export function splitModel(spec: string): { provider: string; model: string } | undefined {
  const i = spec.indexOf('/');
  return i > 0 && i < spec.length - 1 ? { provider: spec.slice(0, i), model: spec.slice(i + 1) } : undefined;
}

const cache = new Map<string, Provider>();

/** Resolves `"openai/gpt-5-mini"`, an alias like `"sonnet"`, or passes a ModelRef through. `presets` adds per-preset settings. */
export function resolveModel(spec: string | ModelRef | undefined, env: Env = process.env, presets: Record<string, PresetOverrides> = {}): ModelRef {
  if (spec && typeof spec === 'object') return spec;
  const name = !spec || spec === 'inherit' ? defaultModel(env) : (MODEL_ALIASES[spec] ?? spec);
  const parts = splitModel(name);
  if (!parts) throw new Error(`model "${name}" must look like "provider/model" (e.g. "openai/gpt-5-mini", "ollama/qwen3:8b")`);
  const overrides = presets[parts.provider];
  const key = `${parts.provider}|${env === process.env ? '' : JSON.stringify(env)}|${overrides ? JSON.stringify(overrides) : ''}`;
  if (!cache.has(key)) cache.set(key, presetProvider(parts.provider, env, overrides));
  return { provider: cache.get(key)!, model: parts.model, pricing: pricingFor(parts.model) };
}

/**
 * Agents whose model resolves to a built-in preset that needs an API key which is not set.
 * Pure config analysis: nothing is called.
 */
export function missingCredentials(
  config: { agents?: Record<string, { model?: string }>; models?: Record<string, { provider: string }>; providers?: Record<string, unknown>; defaultModel?: string },
  env: Env = process.env,
): string[] {
  const problems: string[] = [];
  for (const [name, a] of Object.entries(config.agents ?? {})) {
    let spec = a.model === undefined || a.model === 'inherit' ? (config.defaultModel ?? defaultModel(env)) : a.model;
    if (spec.includes('${')) continue;
    if (config.models?.[spec]) continue; // explicit provider config: its own apiKey setting applies
    spec = MODEL_ALIASES[spec] ?? spec;
    const parts = splitModel(spec);
    if (!parts || config.providers?.[parts.provider]) continue;
    const keyEnv = PRESETS[parts.provider]?.apiKeyEnv;
    if (keyEnv && !env[keyEnv] && !['ollama', 'lmstudio', 'vllm'].includes(parts.provider)) {
      problems.push(`agent "${name}" uses ${spec} but ${keyEnv} is not set (set it, or remove "model" to use the default ${defaultModel(env)})`);
    }
  }
  return problems;
}
