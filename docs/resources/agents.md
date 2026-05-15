---
title: Agents
description: Resource shape for agent configuration.
section: Resources
order: 20
status: stable
---

# Agents

Agent resources define model-backed workers.

## Code Shape

```ts
export default {
  id: "support",
  name: "Support",
  role: "customer support assistant",
  instructions: "Help customers solve support issues.",
  llmOptions: {
    provider: "openai",
    model: "gpt-4o-mini",
  },
  allowedTools: ["search_knowledge"],
};
```

## File Shape

A project can keep agents under `resources/agents/<agent-name>/`.

Common files:

- `config.ts`
- `instructions.md`

## Public Surface

Agents are consumed by:

- `createCopilotz(...)`
- `run(...)` routing through `target`
- `goal(...)` lead and target resolution
- app endpoints that list public agents

## Related Pages

- [Agents](../core-concepts/agents.md)
- [createCopilotz](../reference/create-copilotz.md)
