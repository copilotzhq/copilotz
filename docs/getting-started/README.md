---
title: "Getting Started Guide"
description: "How the guide works and what you'll build across 23 chapters."
section: Getting Started
order: 0
status: stable
---

# Getting Started with Copilotz

This guide takes you from zero to a production-grade AI application. Each chapter builds on the last, introducing complexity only when you feel the pain of not having it.

## How this guide works

Every chapter follows the same rhythm:

1. **The pain** — a real problem you'll hit as your app grows
2. **The solution** — what Copilotz provides and how to use it
3. **What it unlocks** — what's now possible that wasn't before
4. **What's next** — the natural problem that leads to the next chapter

By the end, you'll have built a fully featured AI application with tools, memory, RAG, multi-tenancy, channels, and multi-agent orchestration — and you'll understand *why* each piece exists.

---

## Table of Contents

### Part 1 — Foundations
- [Chapter 1: Hello Agent](./part-1-foundations/01-hello-agent.md) — Get a conversational agent running in minutes
- [Chapter 2: Your First Tool](./part-1-foundations/02-your-first-tool.md) — Give your agent the ability to act

### Part 2 — Tools: From Custom to Protocol
- [Chapter 3: Native Tools](./part-2-tools/03-native-tools.md) — 30 production-ready tools, zero boilerplate
- [Chapter 4: MCP Servers](./part-2-tools/04-mcp-servers.md) — The standard protocol for agent-to-tool communication
- [Chapter 5: OpenAPI as Tools](./part-2-tools/05-openapi-as-tools.md) — Turn any documented API into agent tools

### Part 3 — Skills: Taming Tool Sprawl
- [Chapter 6: Tool Sprawl & Custom Skills](./part-3-skills/06-tool-sprawl-and-skills.md) — Why more tools hurt, and how skills fix it
- [Chapter 7: Native Skills](./part-3-skills/07-native-skills.md) — Expert workflows, ready to use

### Part 4 — Organizing Your Code
- [Chapter 8: The Resource System](./part-4-organizing/08-resource-system.md) — File-based structure, auto-loaded by the framework

### Part 5 — Controlling the Runtime
- [Chapter 9: Custom Processors](./part-5-runtime/09-custom-processors.md) — Middleware-like control over every agent action
- [Chapter 10: The Event System](./part-5-runtime/10-event-system.md) — The full lifecycle, from message to response
- [Chapter 11: Debugging & Observability](./part-5-runtime/11-debugging-and-observability.md) — See what the model received, track costs, export traces

### Part 6 — Memory & Knowledge
- [Chapter 12: RAG](./part-6-memory/12-rag.md) — Ground your agent on proprietary knowledge
- [Chapter 13: Knowledge Graph Collections](./part-6-memory/13-knowledge-graph.md) — Relationships, not just similarity
- [Chapter 14: Long-Term Conversation Memory](./part-6-memory/14-graph-memory.md) — Cache-stable checkpoints for conversations that outgrow raw history

### Part 7 — Production Patterns
- [Chapter 15: Assets](./part-7-production/15-assets.md) — Media handling without breaking the prompt
- [Chapter 16: Channels & The Server Facade](./part-7-production/16-channels-and-server.md) — Ship to WhatsApp, web, Discord, and more
- [Chapter 17: Multi-Tenancy](./part-7-production/17-multi-tenancy.md) — Tenant isolation baked in, not bolted on
- [Chapter 18: Collections — Application Data](./part-7-production/18-collections-application-data.md) — Your business entities, in the same database as your agent
- [Chapter 19: Features — Custom Server Logic](./part-7-production/19-features-custom-server-logic.md) — Webhooks, admin APIs, and custom routes without a second server

### Part 8 — Multi-Agent Systems
- [Chapter 20: Multi-Agent Routing & Delegation](./part-8-multi-agent/20-multi-agent.md) — Agent teams, not monoliths
- [Chapter 21: Goals — Automated Testing & Agent Simulation](./part-8-multi-agent/21-goals-testing.md) — Test agents with agents, score conversations with a judge

### Part 9 — Deep Customization
- [Chapter 22: Custom LLM Providers](./part-9-customization/22-custom-llm-providers.md) — Plug in any model, any provider
- [Chapter 23: What's Next](./part-9-customization/23-whats-next.md) — Web libraries and beyond

---

## Prerequisites

- [Deno 2.0+](https://deno.com) installed
- An API key for an LLM provider (OpenAI, Anthropic, MiniMax, etc.)

## Setup

Create a new project directory and add Copilotz:

```json
// deno.json
{
  "imports": {
    "@copilotz/copilotz": "jsr:@copilotz/copilotz@^0.46.0"
  }
}
```

That's it. Let's build something.

→ **[Start with Chapter 1: Hello Agent](./part-1-foundations/01-hello-agent.md)**
