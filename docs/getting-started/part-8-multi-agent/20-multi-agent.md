---
title: "Ch 20: Multi-Agent Routing & Delegation"
description: "Build agent teams with routing, delegation, and loop prevention."
section: Getting Started
order: 200
status: stable
---

# Chapter 20: Multi-Agent Routing & Delegation

> **Part 8 — Multi-Agent Systems**

## The pain

One agent with 50 tools, 5 skills, and a 2,000-token system prompt is trying to be a generalist. It's slower. It's more expensive. And it's less reliable — a customer service agent that also knows how to write code and analyze financial data is unfocused in the worst way.

Specialization works. A team of agents, each expert in their domain, coordinating on complex tasks, is more capable than a single mega-agent trying to do everything. But orchestrating multiple agents is hard: how do you route messages to the right agent? How do agents pass work to each other? How do you prevent infinite loops?

## The solution

Copilotz has native multi-agent support built on the same event system you already understand. Agents use the reserved `ask_in_thread` and `handoff_in_thread` controls to communicate inside the current thread. Routing is validated against thread participants and the sender's `allowedAgents`; applications still use the `target` field to choose the first agent.

## A minimal multi-agent setup

```typescript
import { createCopilotz } from "@copilotz/copilotz";

const copilotz = await createCopilotz({
  agents: [
    {
      id: "coordinator",
      name: "Coordinator",
      role: "A coordinator that routes tasks to the appropriate specialist.",
      instructions: `
        You route incoming requests to the right specialist:
        - For customer billing questions → call ask_in_thread with target
          "billing-agent" and a complete question in message
        - For technical issues → call ask_in_thread with target
          "technical-agent" and a complete question in message
        - For anything else → handle it yourself

        After the consulted agent replies, summarize the result for the user.
      `,
      llmOptions: { provider: "openai", model: "gpt-4o" },
      allowedAgents: ["billing-agent", "technical-agent"],
    },
    {
      id: "billing-agent",
      name: "Billing Agent",
      role: "A specialist in billing, invoices, and payment questions.",
      instructions: "You are an expert in billing matters. Be precise and cite specific amounts when possible.",
      llmOptions: { provider: "openai", model: "gpt-4o-mini" },  // Cheaper model for specialists
      allowedTools: ["lookup_customer", "http_request"],
      allowedAgents: null, // Cannot route to another agent
    },
    {
      id: "technical-agent",
      name: "Technical Agent",
      role: "A specialist in technical troubleshooting and engineering questions.",
      instructions: "You are a technical expert. Provide step-by-step troubleshooting instructions.",
      llmOptions: { provider: "openai", model: "gpt-4o" },
      allowedTools: ["http_request", "search_knowledge"],
      allowedAgents: null,
    },
  ],
  multiAgent: {
    enabled: true,
    maxAgentTurns: 5,                 // Prevent infinite agent loops
    maxTurnsFallbackAgent: "coordinator",
  },
  resources: {
    imports: ["tools.http_request", "tools.search_knowledge"],
  },
  // ...
});

copilotz.start();
```

When a user asks "Why was I charged twice this month?", the coordinator asks the billing agent in the same thread, receives its reply, then summarizes for the user.

## How in-thread routing works

Both routing controls require one atomic object:

```typescript
{ target: "billing-agent", message: "Explain why this customer was charged twice." }
```

- `ask_in_thread` delivers `message` to `target`, then returns control to the
  asking agent after the target replies.
- `handoff_in_thread` delivers `message` and transfers the next turn without an
  automatic return.
- `handoff_in_thread` can target `user` when the thread has exactly one human
  participant.

The `message` argument is the complete message the target receives. Do not
duplicate it as visible text. Text outside the control remains public, streams
normally, and is persisted as conversation content; the control block and its
arguments remain hidden. Copilotz injects these controls automatically when
multi-agent routing is enabled and the control has an eligible same-thread
target; they are not regular executable tools and do not belong in `allowedTools`
or `resources.imports`.

An `ask_in_thread` flow looks like this:

```
User message → Coordinator
Coordinator calls ask_in_thread({ target: "billing-agent", message: "Why was this customer charged twice?" })
  → NEW_MESSAGE event: sender=coordinator, target=billing-agent
  → billing-agent processes, responds
  → NEW_MESSAGE event: sender=billing-agent, target=coordinator
Coordinator receives billing-agent's response
Coordinator replies to user
```

Each hop is a `NEW_MESSAGE` event in the same thread. The `agentTurnCount` in
thread metadata increments with each hop. At `maxAgentTurns`, Copilotz uses the
configured fallback agent once or hard-stops routing when no fallback is set.

## Separate child-thread delegation

`delegate_task` is different from the in-thread routing controls. It starts an
isolated child thread for a focused subtask, waits for that agent's final answer,
and returns the answer as a normal tool result. Import and allow it like any
other executable tool:

```typescript
allowedTools: ["delegate_task"],
resources: { imports: ["tools.delegate_task"] },
```

Use `delegate_task` for isolated work that should not join the current
conversation. Use `ask_in_thread` or `handoff_in_thread` for turn-taking among
participants in the current thread.

## Direct routing

Skip the coordinator and route directly to a specialist:

```typescript
const result = await copilotz.run({
  content: "My invoice is wrong",
  sender: { type: "user", name: "Alice" },
  target: "billing-agent", // Route directly — bypasses coordinator
});
```

## The skunk-works preset

Copilotz ships a pre-configured multi-agent topology called `skunk-works` — four specialized agents (west, north, east, south) with an in-thread routing mesh:

```typescript
const copilotz = await createCopilotz({
  resources: {
    preset: ["core", "skunk-works"],
  },
  // ...
});
```

The `skunk-works` preset is designed for complex, open-ended tasks that benefit from parallel specialization. Use it as a starting point and customize the agents for your domain.

## Per-agent model selection

One of the biggest wins of multi-agent architectures: use expensive models only where they earn their cost.

```typescript
agents: [
  {
    id: "coordinator",
    llmOptions: { provider: "openai", model: "gpt-4o" },  // Expensive: strategic decisions
  },
  {
    id: "data-formatter",
    llmOptions: { provider: "openai", model: "gpt-4o-mini" },  // Cheap: formatting tasks
  },
  {
    id: "code-reviewer",
    llmOptions: { provider: "anthropic", model: "claude-opus-4-5" },  // Best for code
  },
]
```

The coordinator thinks carefully. The formatter executes cheaply. The reviewer uses the best model for its specific task. Total cost is lower than a single gpt-4o handling everything.

## Loop prevention

`maxAgentTurns` is the circuit breaker. Set it to the maximum number of agent-to-agent hops you expect for your use case:

```typescript
multiAgent: {
  enabled: true,
  maxAgentTurns: 3,   // Allow up to three consecutive agent-to-agent hops
}
```

When the counter hits the limit, Copilotz routes once to
`maxTurnsFallbackAgent` when configured. Without a fallback agent, routing hard
stops so an agent loop cannot continue.

## Atomic routing messages

Every in-thread control carries its own complete `message`. This makes the next
step explicit and keeps routing metadata out of visible conversation text:

```typescript
ask_in_thread({
  target: "billing-agent",
  message: "Check invoice inv_123 and report duplicate charge evidence.",
});
```

## What this unlocks

- Specialized agents — each focused, each excellent at its domain
- Cost optimization — use powerful models only where necessary
- Supervisor/worker patterns — coordinator routes, specialists execute
- Isolated subtask execution — use `delegate_task` when work belongs in a child thread
- Loop prevention built in — no infinite delegation cycles

## What's next

Every agent in this setup uses a built-in LLM provider. But what if a new provider launches — one with better price-performance for your use case — and Copilotz doesn't support it yet? You don't need to wait for a framework update.

→ **[Chapter 21: Goals — Automated Testing & Agent Simulation](./21-goals-testing.md)**
