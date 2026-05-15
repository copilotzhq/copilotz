---
title: Agents
description: Agents define model behavior, instructions, tools, skills, and runtime options.
section: Core Concepts
order: 20
status: stable
---

# Agents

Agents are the model-facing workers in a Copilotz app.

An agent has identity, instructions, LLM configuration, and optional access to
tools, skills, assets, memory, and RAG.

## Minimal Agent

```ts
const agent = {
  id: "support",
  name: "Support",
  role: "customer support assistant",
  instructions: "Help customers clearly and concisely.",
  llmOptions: {
    provider: "openai",
    model: "gpt-4o-mini",
    apiKey: Deno.env.get("OPENAI_API_KEY"),
  },
};
```

## Agent Identity

Use stable `id` values. Runtime routing, thread participants, `target`, tool
permissions, and goals all benefit from predictable agent IDs.

## Instructions

Instructions define behavior. They should cover:

- the agent's job
- what it should do
- what it should refuse or avoid
- how it should use tools
- how it should respond when uncertain

Agents are not deterministic programs. If a behavior matters, say it directly.

## Tool Access

Tools are not automatically available to every agent.

```ts
const agent = {
  id: "support",
  name: "Support",
  role: "assistant",
  instructions: "...",
  allowedTools: ["get_current_time", "search_knowledge"],
};
```

Use `allowedTools: ["*"]` only when the agent is intentionally trusted with all
available tools.

## Dynamic LLM Configuration

Agents can use static `llmOptions`, or the runtime can resolve provider secrets
and overrides just before the provider call.

Use runtime secret resolution when you do not want API keys persisted in events
or streamed to clients.

## Related Pages

- [Threads and Messages](./threads-and-messages.md)
- [Tools, Features, and Processors](./tools-features-processors.md)
- [createCopilotz](../reference/create-copilotz.md)
