---
name: multi-agent-setup
description: Configure multi-agent communication with routing, delegation, and loop prevention.
allowed-tools: [read_file, write_file]
tags: [framework, agent, multi-agent]
---

# Multi-Agent Setup

Configure multiple agents that communicate, delegate, and collaborate within a conversation.

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
            llmOptions: { provider: "anthropic", model: "claude-sonnet-4-5-20241022" },
            allowedAgents: ["coordinator"],
        },
    ],
    multiAgent: {
        enabled: true,
        maxAgentTurns: 5,           // Prevent infinite loops
        includeTargetContext: true,  // Show "(addressed to: X)" in history
    },
    dbConfig: { url: "..." },
});
```

## Routing

- **@mentions**: Users type `@Researcher, find info on X` to target a specific agent
- **Programmatic**: Use `target` or `targetQueue` in run options
- **Agent delegation**: Agents use `ask_question` tool to query other agents

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

## Loop Prevention

`maxAgentTurns` prevents infinite agent-to-agent conversations:
- Each consecutive agent turn increments a counter
- When the counter reaches `maxAgentTurns`, the next message targets the user
- User messages reset the counter

## allowedAgents

Controls which agents can communicate with each other:

```typescript
allowedAgents: ["researcher", "writer"]  // Can only talk to these
allowedAgents: undefined                  // Can talk to all (default)
```

## Notes

- Each agent can have different LLM providers and models
- `includeTargetContext: true` helps agents understand conversation flow
- Agents maintain persistent memory across conversations via `update_my_memory` tool
