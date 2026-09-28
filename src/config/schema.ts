import type { JsonSchema } from '../types.ts';

const str = { type: 'string' };
const num = { type: 'number', minimum: 0 };
const int = { type: 'integer', minimum: 0 };
const strMap = { type: 'object', additionalProperties: str };
const decision = { enum: ['allow', 'deny', 'ask'] };
const risk = { enum: ['read', 'write', 'exec'] };

const policy = {
  type: 'object',
  additionalProperties: false,
  properties: {
    default: decision,
    risk: { type: 'object', additionalProperties: false, properties: { read: decision, write: decision, exec: decision } },
    rules: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['action'],
        properties: { match: str, risk, action: decision, reason: str },
      },
    },
  },
};

const budget = {
  type: 'object',
  additionalProperties: false,
  properties: {
    maxTurns: int, maxToolCalls: int, maxInputTokens: int, maxOutputTokens: int, maxTotalTokens: int, maxCostUsd: num, maxDurationMs: int,
  },
};

const params = {
  type: 'object',
  additionalProperties: false,
  properties: { temperature: num, maxTokens: int, topP: num, stop: { type: 'array', items: str }, extra: { type: 'object' } },
};

const agent = {
type: 'object',
additionalProperties: false,
properties: {
  description: str,
  model: str,
  instructions: str,
  tools: { type: 'array', items: str },
  params,
  policy,
  budget,
  compaction: { type: 'object', required: ['type', 'thresholdTokens'], properties: { type: str, thresholdTokens: int } },
  output: { type: 'object', required: ['schema'], additionalProperties: false, properties: { schema: { type: 'object' }, retries: int } },
  middleware: { type: 'array', items: str },
  responseCache: { type: 'boolean' },
  asTool: {
    type: 'object',
    additionalProperties: false,
    required: ['description'],
    properties: { name: str, description: str, context: { enum: ['fresh', 'fork'] } },
  },
},
      };

/** Component reference: `{ "type": "<registered type>", ...options }`. */
const component = { type: 'object', required: ['type'], properties: { type: str } };

/** JSON Schema of the configuration file (the subset understood by `validate`). */
export const CONFIG_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    $schema: str,
    defaultModel: str,
    agentsDir: { anyOf: [str, { type: 'array', items: str }] },
    extends: { anyOf: [str, { type: 'array', items: str }] },
    plugins: { type: 'array', items: str },
    defaultAgent: str,
    providers: { type: 'object', additionalProperties: component },
    models: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        required: ['provider', 'model'],
        properties: {
          provider: str,
          model: str,
          params,
          pricing: {
            type: 'object',
            additionalProperties: false,
            required: ['inputPerMTok', 'outputPerMTok'],
            properties: { inputPerMTok: num, outputPerMTok: num, cacheReadPerMTok: num },
          },
          fallback: { type: 'array', items: str },
        },
      },
    },
    mcpServers: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        properties: {
          command: str, args: { type: 'array', items: str }, env: strMap, cwd: str, url: str, headers: strMap,
          prefix: str, risk, include: { type: 'array', items: str }, exclude: { type: 'array', items: str }, timeoutMs: int,
        },
      },
    },
    tools: {
      type: 'object',
      additionalProperties: false,
      properties: {
        workspace: str,
        concurrency: { type: 'integer', minimum: 1 },
        timeoutMs: int,
        maxResultChars: { type: 'integer', minimum: 100 },
        shellTimeoutMs: int,
        artifacts: { enum: ['none', 'memory', 'file'] },
      },
    },
    policy,
    store: component,
    sinks: { type: 'array', items: component },
    agents: {
      type: 'object',
      additionalProperties: agent,
    },
    teams: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        required: ['pattern', 'roles'],
        properties: {
          pattern: str,
          description: str,
          roles: { type: 'object', additionalProperties: { anyOf: [str, agent, { type: 'array', items: { anyOf: [str, agent] } }] } },
          options: { type: 'object' },
        },
      },
    },
    responseCache: { type: 'object', required: ['type'], properties: { type: str, ttlMs: int, namespace: str } },
    memory: {
      type: 'object',
      additionalProperties: false,
      properties: { type: { enum: ['file', 'memory'] }, dir: str, scope: { enum: ['shared', 'agent'] }, namespace: str },
    },
    profiles: { type: 'object', additionalProperties: { type: 'object' } },
  },
};
