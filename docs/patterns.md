# Teams and patterns

A **team** binds members (agents or other teams) to the **roles** of a **pattern**. It runs, streams, nests and
delegates like an agent. It also keeps its own event log (start, input, output, end), aggregates the usage and cost of
its members, and links member runs through `parentRunId`.

Define teams in an agent file (a `pattern` field), in `reinloop.json` under `teams`, or in code with `team()`.

```json
"teams": {
  "research": {
    "pattern": "parallel",
    "description": "Answers with sources from the web and the internal wiki",
    "roles": {
      "workers": ["web-researcher", "wiki-researcher"],
      "aggregator": { "instructions": "Merge the findings; keep citations; flag contradictions." }
    }
  }
}
```

A role accepts an agent or team **name**, an **inline agent** definition (same fields as an agent file), or a list of
them for list roles.

## Built-in patterns

| Pattern | Roles | Options | Behaviour |
|---|---|---|---|
| `chain` | `steps[]` | `template` | Step 1 gets the task; each later step gets the task and the previous output. Stops at the first failure. |
| `parallel` | `workers[]`, `aggregator?` | `template`, `concurrency` | Workers run concurrently. Without an aggregator the output is labelled sections and `data.results`. Repeating the same worker gives voting. |
| `router` | `router` (agent), `routes[]` | `template`, `fallback` | The router returns `{ route, reason }` (schema enforced) and the chosen route handles the original task. Route descriptions guide the choice. |
| `evaluator` | `generator`, `evaluator` (agent) | `maxRounds` (3), `template`, `reviseTemplate` | Generate, then judge (`{ pass, feedback }` enforced), then revise. The generator keeps one conversation across rounds, so its prompt prefix stays cached. Ends `stopped` with `evaluator:maxRounds` if never approved. |
| `orchestrator` | `orchestrator` (agent), `workers[]` | `context: fresh \| fork` | The lead gets the workers as tools and decides what to delegate. |

The texts the patterns add ("Output of the previous step", the evaluation prompt, ...) are exported as `TEMPLATES`
and can be replaced per team through `options.template` / `options.reviseTemplate`. Placeholders are `{{task}}`,
`{{previous}}`, `{{results}}`, `{{routes}}`, `{{candidate}}` and `{{feedback}}`.

## Delegation without a pattern

Listing an agent or team in another agent's `tools` turns it into a delegate tool (`{ task }`) with an isolated
context. `asTool.context: fork` passes the parent's conversation text instead of a fresh context. For most cases
this is simpler than an orchestrator team.

Delegation itself has risk `read`. What the delegate does is checked against the delegate's own policy, which
includes the global `policy` rules. Its "ask" decisions go to the same approver as the parent's. So the parent's
approval flow still covers the delegate's writes and commands, unless the delegate's own policy explicitly allows
them.

## Custom patterns and roles

A pattern is a small object: role specs, optional JSON Schema for options, and `build`, which returns the executor.
Register it from a plugin and use it by name anywhere.

```js
// plugins/debate.mjs  ("plugins": ["./plugins/debate.mjs"])
export default (registry) => registry.patterns.set('debate', {
  description: 'Two advocates argue, a judge decides',
  roles: { pro: { description: 'For' }, con: { description: 'Against' }, judge: { description: 'Decides' } },
  options: { type: 'object', properties: { rounds: { type: 'integer', minimum: 1 } } },
  build: ({ pro, con, judge }, { rounds = 1 }) => async (input, ctx) => {
    const [p, c] = await Promise.all([ctx.call(pro, ctx.task), ctx.call(con, ctx.task)]);
    const verdict = await ctx.call(judge, `PRO: ${p.output}\nCON: ${c.output}`);
    return { output: verdict.output, status: verdict.status };
  },
});
```

The `ctx` passed to the executor provides:

- `ctx.task`: the input as text.
- `ctx.call(member, input, { session })`: runs a member as a linked child run and returns its result. Calls with the
  same `session` key continue one conversation.
- `ctx.signal`: aborts with the team.

Return `{ output, data?, status?, reason? }`.

Role spec fields: `description`, `many` (list role), `optional`, `kind: 'agent'` (for roles whose output schema or
tools the pattern changes). Roles and options are validated when the team is built, with readable errors.
