# Ecosystem

reinloop is installable and useful on its own. This page lists the projects around it and how they connect.

## The family

- **reinloop** is the runtime: agents as files, budgets, approvals, durable resume, OpenTelemetry, zero dependencies.
- **[agent-layers](https://github.com/aantenore/agent-layers)** is the eleven-layer SDK where reinloop is one runtime
  adapter (`@agent-layers/adapters/reinloop`).
- **[agent-plexus](https://github.com/aantenore/agent-plexus)** is multi-agent composition where an agent-layers stack
  is the host.
- **[Lorebase](https://github.com/aantenore/lorebase)** is the governed, versioned knowledge graph agents read over MCP.

## Layer integrations

reinloop provides the hooks; agent-layers provides the layers. reinloop keeps the contracts (`Identity`,
`IdentityVerifier`, `CredentialProvider`, `Authorizer`, `Guard`, `KnowledgeSource`, `ModelRouter`, `Evaluator`), the
places they plug in (run identity and credentials, policy `when` rules and the `policy.pdp` hook, `serve` bearer
verification, MCP per-call auth, `guardMiddleware`, `knowledgeMiddleware`, routed models, layer tags on OTLP spans and
metrics) and registry entries that plugins fill. Implementations such as OIDC, OPA/AuthZEN, Presidio, LLM Guard,
knowledge sources, HTTP/OpenAPI tools, rule routing and evaluation are agent-layers adapters in
`@agent-layers/adapters` (0.4.0 or later). See [layers/README.md](layers/README.md).

## Pi packages

The parts of this work that fill gaps in the [Pi](https://github.com/earendil-works/pi) ecosystem ship as Pi packages:
[`@aantenore/pi-otel`](https://github.com/aantenore/pi-otel) (OpenTelemetry for Pi; passes Pi's telemetry
conformance suite) and [`@aantenore/pi-budget`](https://github.com/aantenore/pi-budget) (hard USD, token, turn,
tool-call and time limits for Pi). Use reinloop for a standalone, zero-dependency runtime; use the Pi packages if you
already run Pi.
