# Agents

Agents define orchestration behavior, instructions, allowed tools, and model
configuration.

## Where It Lives

```txt
resources/agents/<agent-name>/
```

## What It Is For

Use an agent resource when you need a named runtime actor with instructions,
tool access, and execution identity.

Recommended use case: define a reusable runtime actor  
Most common mistaken alternative: putting all behavior in tools without an
owning agent

## How Copilotz Consumes It

- agents are loaded into the runtime config
- the run engine uses them during `run()` and thread execution
- multi-agent flows build on agent definitions plus runtime state

## Minimal Example

```ts
export default {
  id: "assistant",
  name: "Assistant",
  role: "assistant",
  instructions: "Be clear and helpful.",
};
```

## Public Surface

Agents are visible through runtime execution and can be listed through the app
layer, but they are not direct CRUD endpoints by default.

## Related Pages

- [Add Agent Capabilities with Tools](../playbooks/add-agent-capabilities-with-tools.md)
- [LLM Providers](./llm.md)
- [createCopilotz](../reference/create-copilotz.md)
