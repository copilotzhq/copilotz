---
name: multi-agent-setup
description: Configure same-thread routing, child-thread delegation, and loop prevention.
allowed-tools: [read_file, write_file]
tags: [framework, agent, multi-agent]
---

# Multi-Agent Setup

Configure multiple agents that communicate and collaborate in one conversation,
with optional child-thread delegation for isolated work.

## Enable Multi-Agent

```typescript
const copilotz = await createCopilotz({
  agents: [
    {
      id: "coordinator",
      name: "Coordinator",
      role: "assistant",
      instructions: "Route user requests to the right specialist.",
      llmOptions: { provider: "openai", model: "gpt-4o" },
      allowedAgents: ["researcher", "writer"],
    },
    {
      id: "researcher",
      name: "Researcher",
      role: "assistant",
      instructions: "Find and analyze information.",
      llmOptions: { provider: "openai", model: "gpt-4o-mini" },
      allowedTools: ["search_knowledge", "http_request"],
      allowedAgents: ["coordinator"],
    },
    {
      id: "writer",
      name: "Writer",
      role: "assistant",
      instructions: "Write clear, polished content.",
      llmOptions: {
        provider: "anthropic",
        model: "claude-sonnet-4-5-20241022",
      },
      allowedAgents: ["coordinator"],
    },
  ],
  multiAgent: {
    enabled: true,
    maxAgentTurns: 5, // Prevent infinite loops
    maxTurnsFallbackAgent: "coordinator",
  },
  dbConfig: { url: "..." },
});
```

## Routing

- **@mentions**: Users type `@Researcher, find info on X` to target a specific
  agent
- **Programmatic**: Use `target` or `targetQueue` in run options
- **Same-thread consultation**: Agents call `ask_in_thread` with atomic
  `{ target, message }`; control returns after the target replies
- **Same-thread handoff**: Agents call `handoff_in_thread` with atomic
  `{ target, message }`; the next turn transfers without automatic return
- **Child-thread delegation**: Agents call the regular `delegate_task` tool for
  an isolated subtask and wait for its final answer

```typescript
// Programmatic routing
await copilotz.run({
  content: "Analyze this data",
  sender: { type: "user", name: "Alex" },
  target: "researcher",
});

// Sequential routing
await copilotz.run({
  content: "Research and then write a summary",
  sender: { type: "user", name: "Alex" },
  targetQueue: ["researcher", "writer"],
});
```

The routing controls are injected automatically for allowed agent participants.
Do not add them to `allowedTools` or `resources.imports`, and do not duplicate
their `message` argument as visible text. `delegate_task` is an executable tool
and must be imported and allowed when used.

## Loop Prevention

`maxAgentTurns` prevents infinite agent-to-agent conversations:

- Each consecutive agent turn increments a counter
- When the counter reaches `maxAgentTurns`, routing uses
  `maxTurnsFallbackAgent` once when configured; otherwise it hard-stops
- User messages reset the counter

## allowedAgents

Controls which agents can communicate with each other:

```typescript
allowedAgents: ["researcher", "writer"]; // Can only talk to these
allowedAgents: undefined; // Can talk to all (default)
allowedAgents: null; // Cannot route to another agent
```

## Notes

- Each agent can have different LLM providers and models
- Agents maintain persistent memory across conversations via `update_my_memory`
  tool
