import type { JsonSchema } from '../types.ts';

const str = { type: 'string' };
const num = { type: 'number', minimum: 0 };
const int = { type: 'integer', minimum: 0 };
const strMap = { type: 'object', additionalProperties: str };
/** Shallow shape check of a JSON Schema: catches `{ text: "string" }` instead of `{ text: { type: "string" } }`. */
const jsonSchema = {
  type: 'object',
  properties: { properties: { type: 'object', additionalProperties: { type: 'object' } }, required: { type: 'array', items: { type: 'string' } } },
};
const pricing = {
  type: 'object',
  additionalProperties: false,
  properties: {
    inputPerMTok: num, outputPerMTok: num, cacheReadPerMTok: num, cacheWriteMultiplier: num, cacheWrite1hMultiplier: num,
    serverToolUsd: { type: 'object', additionalProperties: num },
  },
};
/** `auth` of HTTP tools, OpenAPI sources and MCP servers: a delegated token for `audience` from the run's credentials. */
const toolAuth = { type: 'object', additionalProperties: false, required: ['audience'], properties: { audience: str, scopes: { type: 'array', items: str } } };
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
        properties: {
          match: str, risk, action: decision, reason: str,
          when: {
            type: 'object',
            additionalProperties: false,
            properties: { roles: { type: 'array', items: str }, scopes: { type: 'array', items: str }, kind: { enum: ['user', 'agent'] } },
          },
        },
      },
    },
    /** External PDP: `type` names a registered authorizer; other options go to its factory. */
    pdp: { type: 'object', required: ['type'], properties: { type: str, url: str, onError: decision, includeArgs: { type: 'boolean' }, headers: strMap } },
  },
};

/** Identity component: `type` defaults to `oidc`. */
const identityComponent = { type: 'object', properties: { type: str } };

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
  properties: {
    temperature: num, maxTokens: int, topP: num, stop: { type: 'array', items: str }, extra: { type: 'object' },
    thinking: {
      type: 'object', additionalProperties: false, required: ['type'],
      properties: { type: { enum: ['adaptive', 'enabled', 'disabled', 'between_tools'] }, budgetTokens: int, display: { enum: ['omitted', 'summarized', 'updates'] } },
    },
    effort: { enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
    retryMaxTokens: int,
    cache: { type: 'boolean' },
    cacheTtl: { enum: ['5m', '1h'] },
  },
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
  output: { type: 'object', required: ['schema'], additionalProperties: false, properties: { schema: jsonSchema, retries: int } },
  middleware: { type: 'array', items: str },
  responseCache: { type: 'boolean' },
  router: str,
  skills: { type: 'array', items: str },
  asTool: {
    type: 'object',
    additionalProperties: false,
    required: ['description'],
    properties: { name: str, description: str, context: { enum: ['fresh', 'fork'] }, forwardEvents: { type: 'boolean' } },
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
    skillsDir: { anyOf: [str, { type: 'array', items: str }] },
    extends: { anyOf: [str, { type: 'array', items: str }] },
    plugins: { type: 'array', items: str },
    defaultAgent: str,
    providers: { type: 'object', additionalProperties: component },
    presets: { type: 'object', additionalProperties: { type: 'object', additionalProperties: false, properties: { headers: strMap } } },
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
          pricing: { type: 'object', additionalProperties: false, required: ['inputPerMTok', 'outputPerMTok'], properties: pricing.properties },
          fallback: { type: 'array', items: str },
        },
      },
    },
    pricing: { type: 'object', additionalProperties: pricing },
    mcpServers: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        properties: {
          command: str, args: { type: 'array', items: str }, env: strMap, cwd: str, url: str, headers: strMap,
          prefix: { anyOf: [str, { const: false }] }, risk, include: { type: 'array', items: str }, exclude: { type: 'array', items: str }, readOnly: { type: 'array', items: str }, timeoutMs: int,
          auth: toolAuth,
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
    identity: {
      type: 'object',
      additionalProperties: false,
      properties: { verifier: identityComponent, credentials: identityComponent, required: { type: 'boolean' } },
    },
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
    hostedTools: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        required: ['provider', 'type'],
        properties: { provider: str, type: str, params: { type: 'object' }, risk, description: str, limitParam: str, beta: str },
      },
    },
    web: {
      type: 'object',
      additionalProperties: false,
      properties: {
        provider: { enum: ['tavily', 'anthropic-native'] },
        apiKey: str,
        model: str,
        maxUses: { type: 'integer', minimum: 1 },
        maxResults: { type: 'integer', minimum: 1 },
        maxResultsCap: { type: 'integer', minimum: 1 },
        maxChars: { type: 'integer', minimum: 50 },
        maxFetchChars: { type: 'integer', minimum: 100 },
        cacheTtlMs: int,
        fetchPolicy: { enum: ['search-results', 'any', 'off'] },
        maxUrlLength: { type: 'integer', minimum: 16 },
        searchDepth: { enum: ['basic', 'advanced'] },
        topic: { enum: ['general', 'news'] },
        includeDomains: { type: 'array', items: str },
        excludeDomains: { type: 'array', items: str },
      },
    },
    signals: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sources: { type: 'array', items: { enum: ['hackernews', 'github', 'stackoverflow', 'arxiv'] } },
        maxResults: { type: 'integer', minimum: 1 },
        maxResultsCap: { type: 'integer', minimum: 1 },
        maxChars: { type: 'integer', minimum: 20 },
        cacheTtlMs: int,
        timeoutMs: { type: 'integer', minimum: 100 },
        githubToken: str,
        githubIssues: { type: 'boolean' },
        stackExchangeSite: str,
        userAgent: str,
      },
    },
    routers: { type: 'object', additionalProperties: component },
    knowledge: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sources: {
          type: 'object',
          additionalProperties: {
            type: 'object',
            additionalProperties: false,
            required: ['type'],
            properties: {
              type: { enum: ['mcp', 'http', 'wiki'] },
              server: str, command: str, args: { type: 'array', items: str }, env: strMap, cwd: str, url: str, headers: strMap,
              tool: str, queryArg: str, toolArgs: { type: 'object' }, timeoutMs: int, dir: str, maxPassageChars: { type: 'integer', minimum: 100 },
            },
          },
        },
        k: { type: 'integer', minimum: 1 },
        maxChars: { type: 'integer', minimum: 100 },
        mode: { enum: ['first-turn', 'every-turn'] },
        timeoutMs: { type: 'integer', minimum: 100 },
      },
    },
    httpTools: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        required: ['description', 'method', 'url', 'schema'],
        properties: {
          description: str, method: { enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] }, url: str,
          query: { type: 'array', items: str }, headerArgs: { type: 'array', items: str }, headers: strMap,
          body: { enum: ['json', 'none'] }, bodyArg: str, schema: jsonSchema, risk,
          timeoutMs: int, maxResultChars: { type: 'integer', minimum: 100 }, auth: toolAuth,
        },
      },
    },
    openapi: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        required: ['spec'],
        properties: {
          spec: str, baseUrl: str, include: { type: 'array', items: str }, auth: toolAuth, headers: strMap,
          timeoutMs: int, maxResultChars: { type: 'integer', minimum: 100 },
        },
      },
    },
    guardrails: {
      type: 'object',
      additionalProperties: false,
      required: ['guards'],
      properties: { guards: { type: 'array', items: component }, onError: { enum: ['block', 'allow'] }, name: str },
    },
    profiles: { type: 'object', additionalProperties: { type: 'object' } },
  },
};
