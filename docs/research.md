# Research notes (September 2026)

These notes summarise what practitioners report about current agent frameworks and harnesses, and what the findings
imply for reinloop's design.

## Verdict

Another general-purpose orchestration framework is not worth building. The market has 20+ actively promoted options,
and orchestration is widely seen as commoditised. A **harness kernel** is worth building if it combines three things:

- an explicit loop that the developer owns;
- the operational layer every production agent rebuilds (permissions, budgets, durability, compaction, tracing);
- a portable, declarative unit (the agent file) that removes code from the common case.

## What people complain about

| Finding | Source |
|---|---|
| Abstractions obscure prompts and responses and make debugging harder; start from direct API calls | [Anthropic, Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) |
| Teams reach 70-80% quality with a framework, then reverse-engineer it; own your prompts, context window and control flow | [12-factor agents](https://github.com/humanlayer/12-factor-agents) |
| Production agents are mostly deterministic software with LLM calls at key points; frameworks called "a waste of time" | [HN discussion](https://news.ycombinator.com/item?id=43699271) |
| Provider SDKs matured; the cost of heavy abstractions now exceeds the benefit | [Stop using LangChain in 2026](https://elshadk.substack.com/p/stop-using-langchain-in-2026) |
| Poor in-task logging, hard unit testing, slow runs; mandatory telemetry | [CrewAI review 2026](https://www.agentrank.tech/blog/crewai-review-multi-agent-framework-2026) |
| Tool sandboxes as an afterthought led to chained RCE vulnerabilities | [SecurityWeek](https://www.securityweek.com/crewai-vulnerabilities-expose-devices-to-hacking/) |
| Three deliberately breaking major versions in under two years | [AI SDK migration notes](https://thepromptshelf.dev/blog/claude-code-vercel-ai-sdk-guide-2026/) |
| "The bitter lesson" applies to frameworks: models improve and scaffolding becomes a liability | [browser-use](https://browser-use.com/posts/bitter-lesson-agent-frameworks) |
| Counterpoint: the loop is free to write but not free to operate | [Choosing an agent framework](https://zorost.com/choosing-an-agent-framework) |
| Differentiation moved from orchestration to integrations, trust boundary and deployment shape | [Agent frameworks 2026](https://www.startuphub.ai/ai-news/insights/2026/ai-agent-frameworks-2026) |
| Declarative agent configs are spreading (CrewAI YAML, ADK Agent Config, cagent, AgentSchema, Open Agent Spec) with no interoperability | [ADK agent config](https://google.github.io/adk-docs/agents/config/), [MAF discussion](https://github.com/microsoft/agent-framework/discussions/1294) |
| A ~100-line, bash-only, model-agnostic agent scores >74% on SWE-bench Verified | [mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent) |
| Harness best practice: stable prefix, append-only history, fixed tool catalogue per session, compaction with retrievable offloads; worker vs verifier subagents | [Harness engineering notes](https://gist.github.com/amazingvince/52158d00fb8b3ba1b8476bc62bb562e3) |
| Tool count degrades quality non-linearly; bloated instruction files add 20%+ token cost | [Harness vs framework](https://atlan.com/know/ai-agent/agent-harness-vs-agent-framework/) |
| OTel GenAI conventions for model and tool spans are stable enough to build on; agent spans still moving | [GreptimeDB on GenAI semconv](https://greptime.com/blogs/2026-05-09-opentelemetry-genai-semantic-conventions) |
| Durable execution via checkpoint and event-sourced replay; read-only / sandboxed-edit / full-access tiers with HITL | [AI agent runtime](https://slavadubrov.github.io/blog/2026/05/26/ai-agent-runtime/), [Orca](https://orca.security/resources/blog/best-ai-agent-runtime-tools-platforms/) |
| Install size and runtime latency are decoupled, so measure before claiming "lightweight" | [Framework benchmark](https://dev.to/benchclaw/we-ran-160-agent-tasks-across-two-frameworks-the-frameworks-tied-then-we-changed-the-model-3hip) |

## How each finding shaped reinloop

| Finding | Decision |
|---|---|
| Hidden loop and prompts | ~200-line loop; events and hooks at every step; harness texts are exported constants |
| Framework ceiling | Everything is replaceable (providers, stores, patterns, middleware), and the loop can be copied |
| Weight and churn | Zero runtime dependencies, small surface, versioned file format and event protocol |
| Operating cost of DIY loops | Budgets, policy, resume, compaction, retries, caching and tracing as configuration |
| Competing declarative schemas | Reuse the Markdown-plus-frontmatter subagent format people already write, instead of a new YAML dialect |
| Tool-count degradation | Per-agent tool lists and globs, MCP `include`/`exclude`, delegation to focused subagents |
| Cache efficiency | Append-only history, stable tool catalogue, Anthropic breakpoints, evaluator sessions that keep the generator prefix |
| Multi-agent hype | Patterns are opt-in and explicit; a plain agent with delegate tools is the default recommendation |
| Security | Risk tiers, ask-by-default for write/exec, deny when nobody can approve, workspace confinement, localhost-only server by default |
| Measure before claiming | `npm run bench` publishes import and per-turn overhead |
