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

Copilotz has native multi-agent support built on the same event system you already understand. Agents can delegate to other agents using the `delegate` tool. Routing happens automatically based on agent `allowedAgents` and the `target` field on messages.

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
        - For customer billing questions → delegate to the billing-agent
        - For technical issues → delegate to the technical-agent
        - For anything else → handle it yourself

        After delegating, summarize the specialist's response for the user.
      `,
      llmOptions: { provider: "openai", model: "gpt-4o" },
      allowedAgents: ["billing-agent", "technical-agent"],  // Can delegate to these
      allowedTools: ["delegate"],
    },
    {
      id: "billing-agent",
      name: "Billing Agent",
      role: "A specialist in billing, invoices, and payment questions.",
      instructions: "You are an expert in billing matters. Be precise and cite specific amounts when possible.",
      llmOptions: { provider: "openai", model: "gpt-4o-mini" },  // Cheaper model for specialists
      allowedTools: ["lookup_customer", "http_request"],
      // No allowedAgents — this agent cannot delegate further
    },
    {
      id: "technical-agent",
      name: "Technical Agent",
      role: "A specialist in technical troubleshooting and engineering questions.",
      instructions: "You are a technical expert. Provide step-by-step troubleshooting instructions.",
      llmOptions: { provider: "openai", model: "gpt-4o" },
      allowedTools: ["http_request", "search_knowledge"],
    },
  ],
  multiAgent: {
    enabled: true,
    maxAgentTurns: 5,             // Prevent infinite delegation loops
    includeTargetContext: true,    // Agents know they're part of a delegation chain
  },
  resources: {
    imports: ["tools.delegate", "tools.http_request", "tools.search_knowledge"],
  },
  // ...
});

copilotz.start();
```

When a user asks "Why was I charged twice this month?", the coordinator delegates to the billing-agent, which handles the question and responds. The coordinator summarizes and replies to the user.

## How delegation works

When an agent calls the `delegate` tool:

```
User message → Coordinator
Coordinator calls delegate(agent: "billing-agent", message: "User asks: why was I charged twice?")
  → NEW_MESSAGE event: sender=coordinator, target=billing-agent
  → billing-agent processes, responds
  → NEW_MESSAGE event: sender=billing-agent, target=coordinator
Coordinator receives billing-agent's response
Coordinator replies to user
```

Each hop is a `NEW_MESSAGE` event in the same thread. The `agentTurnCount` in thread metadata increments with each hop. When it exceeds `maxAgentTurns`, the current agent's response goes directly to the user, breaking any potential loop.

## Direct routing

Skip the coordinator and route directly to a specialist:

```typescript
const result = await copilotz.run(
  { content: "My invoice is wrong", sender: { type: "user", name: "Alice" } },
  { target: "billing-agent" }  // Route directly — bypasses coordinator
);
```

## The skunk-works preset

Copilotz ships a pre-configured multi-agent topology called `skunk-works` — four specialized agents (west, north, east, south) with a delegation mesh:

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
  maxAgentTurns: 3,   // coordinator → specialist → back to coordinator = 3 turns
}
```

When the counter hits the limit, the active agent's response goes directly to the user. You'll see a note in the thread metadata that the turn limit was reached.

## Seeing the delegation chain

Enable `includeTargetContext: true` to give each agent visibility into the delegation chain. This lets specialists know they're responding to another agent (not the end user) and adjust their response format accordingly:

```typescript
// Specialist knows it's replying to the coordinator, not the user
// Can respond with structured data instead of natural language
```

## What this unlocks

- Specialized agents — each focused, each excellent at its domain
- Cost optimization — use powerful models only where necessary
- Supervisor/worker patterns — coordinator routes, specialists execute
- Parallel task execution — multiple specialists working simultaneously
- Loop prevention built in — no infinite delegation cycles

## What's next

Every agent in this setup uses a built-in LLM provider. But what if a new provider launches — one with better price-performance for your use case — and Copilotz doesn't support it yet? You don't need to wait for a framework update.

→ **[Chapter 21: Goals — Automated Testing & Agent Simulation](./21-goals-testing.md)**
