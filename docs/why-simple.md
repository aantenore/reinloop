# Is reinloop actually simpler?

This compares the same tasks across popular options. Competitor snippets are abridged to their documented idiomatic
form (imports omitted) and may drift as those projects evolve.

## 1. One agent, one tool

**reinloop, no code.** `agents/assistant.md`:

```markdown
---
model: openai/gpt-5-mini
tools: [read_file, search_files]
---
Answer questions about this folder. Cite paths.
```

`reinloop run "Where is the retry logic?"`

**reinloop, code:**

```ts
const weather = tool('weather', 'Current weather', { city: 'string' }, ({ city }) => `Sunny in ${city}`);
console.log((await agent({ model: 'openai/gpt-5-mini', tools: [weather] }).run('Weather in Rome?')).output);
```

**OpenAI Agents SDK (Python):**

```python
@function_tool
def get_weather(city: str) -> str:
    return f"Sunny in {city}"

agent = Agent(name="Assistant", instructions="Be brief.", tools=[get_weather])
print(Runner.run_sync(agent, "Weather in Rome?").final_output)
```

**PydanticAI:**

```python
agent = Agent("openai:gpt-5-mini", instructions="Be brief.")

@agent.tool_plain
def get_weather(city: str) -> str:
    return f"Sunny in {city}"

print(agent.run_sync("Weather in Rome?").output)
```

**Vercel AI SDK:**

```ts
const { text } = await generateText({
  model: 'openai/gpt-5-mini',
  tools: { weather: tool({ description: 'Weather', inputSchema: z.object({ city: z.string() }), execute: async ({ city }) => `Sunny in ${city}` }) },
  stopWhen: stepCountIs(5),
  prompt: 'Weather in Rome?',
});
```

**LangChain v1 / LangGraph:**

```python
agent = create_agent("openai:gpt-5-mini", tools=[get_weather], system_prompt="Be brief.")
agent.invoke({"messages": [{"role": "user", "content": "Weather in Rome?"}]})
```

**CrewAI:**

```python
researcher = Agent(role="Researcher", goal="Answer weather questions", backstory="...", tools=[weather_tool])
task = Task(description="Weather in Rome?", expected_output="One sentence", agent=researcher)
Crew(agents=[researcher], tasks=[task]).kickoff()
```

**Verdict.** For hello-world, OpenAI Agents SDK, PydanticAI and reinloop's code API are equally short. reinloop is the
only one where the agent needs no code at all and runs unchanged on any provider.

## 2. The agent in production

What you add to the hello-world before trusting it with real work:

| Concern | reinloop | Typical framework |
|---|---|---|
| Stop runaway loops and spend | `budget: { maxTurns, maxCostUsd, maxDurationMs }` (default 50 turns) | Max-turns or step limits are common; cost and time limits are usually custom code |
| Approve risky actions | Built-in risk tiers + rules; CLI asks, API denies unless allowed | Varies: callbacks, interrupts or custom guardrails |
| Survive crashes / continue later | Automatic: event log + `reinloop resume <id>` | Checkpointer or session store to choose, configure and wire |
| Keep long tasks in context | `compaction: { type: summarize, thresholdTokens }` | Often left to the application |
| Tracing | `sinks: [{ type: jsonl }]` or OTel GenAI spans with your tracer | Often a vendor platform or extra SDK |
| Switch model or provider | Change one string | Often a different package or client class |
| Expose as API / to IDEs | `reinloop serve`, `reinloop mcp` | Separate server code |

This is where reinloop is simplest: the operational layer is policy in a file, not code you write and maintain.

## 3. Multi-agent

**reinloop:** one file per team, and roles point at agents by name.

```markdown
---
pattern: evaluator
roles: { generator: writer, evaluator: editor }
---
```

The other patterns are just as short: `chain`, `parallel`, `router` and `orchestrator`, plus your own. Teams nest,
are usable as tools, and aggregate cost across members.

Elsewhere: handoffs or agents-as-tools in code (OpenAI Agents SDK), explicit graphs of nodes and edges (LangGraph),
crews with processes (CrewAI), or hand-written workflow code. These are all powerful, and all of them need code for
patterns that are really configuration.

## Where others are ahead

Be clear about the trade-offs before choosing:

- **Ecosystem and integrations.** LangChain/LangGraph, CrewAI and Mastra ship far more prebuilt connectors.
  reinloop relies on MCP servers for breadth.
- **Python.** Most AI teams work in Python and reinloop is TypeScript/Node. The agent files, CLI, HTTP API and MCP
  server make it usable from any language, but there is no Python library.
- **Graphs with complex state.** When a workflow needs arbitrary cycles over typed shared state, LangGraph's model is
  more expressive than reinloop's patterns. You can register a custom pattern, but that is code.
- **Hosted platforms.** Managed deployment, evaluation dashboards and visual studios are out of scope.
- **Maturity.** reinloop is young; the others have large communities and years of production use.

## Why not a drag-and-drop builder?

Low-code canvases (Flowise, Langflow, Dify, n8n) exist and are good at demos. Their weak points match the
practitioner complaints behind this project: state lives outside version control, flows are hard to diff, review and
test, and teams hit a ceiling that ends in rewriting. reinloop keeps the low-code benefit, where describing an agent
is enough, but produces **text files**:

- `reinloop new` gives a template, and `reinloop create "..."` writes and validates files from a description;
- `reinloop serve` includes a small web console to run agents and watch events.

The files work with git, code review and CI, and agents can edit them too.
