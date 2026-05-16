---
title: "Ch 23: What's Next"
description: "Web libraries, React UI, and where to go from here."
section: Getting Started
order: 230
status: stable
---

# Chapter 23: What's Next

> **Part 9 — Deep Customization**

## You've come a long way

When you started Chapter 1, you had a terminal script. Now you have:

- A multi-agent system with specialized agents
- Tools sourced from custom code, native library, MCP servers, and OpenAPI specs
- Skills that keep context lean without sacrificing capability
- A clean, file-based resource structure
- Custom processors that intercept and control every agent action
- Full visibility into the event lifecycle
- RAG grounded on proprietary knowledge
- A knowledge graph that understands relationships
- Graph memory that scales instead of bloating
- Smart asset handling for images and files
- A production HTTP server with channels, collections, and custom features
- Schema-level multi-tenancy ready for B2B workloads
- The ability to integrate any LLM provider

That's a complete production AI application. This final chapter covers one more topic and points you toward the full documentation.

---

## Web libraries

Your server is ready. Your agent is running. The last piece is the client. Copilotz provides client-side utilities for consuming the SSE event stream, managing conversation state, uploading assets, and rendering chat UI:

```typescript
import { createCopilotStream } from "@copilotz/copilotz/web";

const stream = createCopilotStream("/api/chat");

stream.onToken((token) => {
  appendToChat(token);
});

stream.onEvent("APPROVAL_REQUIRED", (event) => {
  showApprovalDialog(event.payload);
});

await stream.send({
  message: "Hello!",
  threadId: currentThreadId,
});
```

Included:
- SSE stream consumer with typed event handling
- Conversation state manager (threads, messages, loading state)
- Asset upload with progress and inline preview
- React and Svelte component primitives for chat UI

See the [Web library reference](../../reference/web.md) for the full API.

---

## The mental model, in full

Every extension point in Copilotz follows the same pattern:

```
Everything is a resource.
Resources live in resources/.
Resources are auto-loaded by createCopilotz().
Resources plug into well-defined interfaces.
```

| What you're extending | Resource directory | Interface |
|-----------------------|-------------------|-----------|
| Agents | `resources/agents/` | `AgentConfig` |
| Tools | `resources/tools/` | `ToolDefinition` |
| Skills | `resources/skills/` | `SKILL.md` |
| Processors | `resources/processors/` | `EventProcessor` |
| Channels | `resources/channels/` | `IngressAdapter + EgressAdapter` |
| LLM providers | `resources/llm/` | `ProviderFactory` |
| Embedding providers | `resources/embeddings/` | `EmbeddingProviderFactory` |
| Storage adapters | `resources/storage/` | `StorageAdapter` |
| Collections | `resources/collections/` | `CollectionDefinition` |
| Features | `resources/features/` | action handler function |
| Memory resources | `resources/memory/` | `MemoryResource` |

If it exists in the framework, it has an interface you can implement.

---

## Where to go from here

- **[API Reference](../../reference/)** — Complete type documentation for every interface
- **[Examples](../../../examples/)** — Working code for common patterns
- **[RAG Deep Dive](../../core-concepts/rag.md)** — Chunking strategies, embedding models, retrieval tuning
- **[Event System Reference](../../core-concepts/events.md)** — Every event type, payload shape, and processor contract
- **[Multi-Agent Patterns](../../build-guides/multi-agent.md)** — Topologies, delegation strategies, and loop prevention
- **[Deployment Guide](../../build-guides/deployment.md)** — PostgreSQL setup, scaling, observability

---

## Thank you

Copilotz exists because building production AI applications is genuinely hard — not because of the LLMs, but because of everything around them. We hope this guide saved you weeks of infrastructure work and let you focus on what matters: the product you're building.

If something's unclear, wrong, or missing — [open an issue](https://github.com/copilotz/copilotz/issues). The guide improves when you tell us what didn't work.

Go build something.
