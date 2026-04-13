```
╔═════════════════════════════════════════════════════════════════╗
║                                                                 ║
║   ██████╗ ██████╗ ██████╗ ██╗██╗      ██████╗ ████████╗███████╗ ║
║  ██╔════╝██╔═══██╗██╔══██╗██║██║     ██╔═══██╗╚══██╔══╝╚══███╔╝ ║
║  ██║     ██║   ██║██████╔╝██║██║     ██║   ██║   ██║     ███╔╝  ║
║  ██║     ██║   ██║██╔═══╝ ██║██║     ██║   ██║   ██║    ███╔╝   ║
║  ╚██████╗╚██████╔╝██║     ██║███████╗╚██████╔╝   ██║   ███████╗ ║
║   ╚═════╝ ╚═════╝ ╚═╝     ╚═╝╚══════╝ ╚═════╝    ╚═╝   ╚══════╝ ║
║                                                                 ║
╚═════════════════════════════════════════════════════════════════╝
```


# Copilotz

**The full-stack framework for AI applications.**

LLM wrappers give you chat. Copilotz gives you everything else: persistent memory, RAG, tool calling, background jobs, and multi-tenancy — in one framework.

Build AI apps, not AI infrastructure.



[![Deno](https://img.shields.io/badge/Deno-2.0+-000?logo=deno)](https://deno.land)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

---

## The Problem

Building AI features today feels like building websites in 2005.

You start with an LLM wrapper. Then you need memory — so you add Redis. Then RAG — so you add a vector database. Then your tool generates an image — now you need asset storage and a way to pass it back to the LLM. Then background jobs, multi-tenancy, tool calling, handling media, observability... Before you know it, you're maintaining infrastructure instead of building your product.

**There's no Rails for AI. No Next.js. Just parts.**

## The Solution

Copilotz is the full-stack framework for AI applications. Everything you need to ship production AI, in one package:

| What You Need | What Copilotz Gives You |
|---------------|------------------------|
| Memory | Knowledge graph that remembers users, conversations, and entities |
| RAG | Document ingestion, chunking, embeddings, and semantic search |
| Skills | SKILL.md-based instructions with progressive disclosure and a bundled admin agent |
| Tools | 27 native tools + OpenAPI integration + MCP support |
| Assets | Automatic extraction, storage, and LLM resolution of images and files |
| Background Jobs | Event queue with persistent workers and custom processors |
| Multi-tenancy | Schema isolation + namespace partitioning |
| Database | PostgreSQL (production) or PGLite (development/embedded) |
| Channels | Web (SSE), WhatsApp, and Zendesk — import and go |
| Streaming | Real-time token streaming with async iterables |
| Usage & Cost | Provider-native token usage tracking plus optional OpenRouter-based cost estimation |

**One framework. One dependency. Production-ready.**

---

## Quick Start

### Create a New Project

Scaffold a full Copilotz project with API routes, a React chat UI, and everything wired up:

```bash
deno run -Ar jsr:@copilotz/copilotz/create my-app
```

Then follow the prompts:

```bash
cd my-app
# Edit .env with your API keys
deno task dev           # start the API server
deno task dev:web       # start the web UI
```

This uses the [copilotz-starter](https://github.com/copilotzhq/starter) template -- a minimal but complete reference app with threads, knowledge graph, assets, and a chat UI.

### Add to an Existing Project

```bash
deno add jsr:@copilotz/copilotz
```

### Interactive Mode (Fastest)

Try Copilotz instantly with an interactive chat:

```typescript
import { createCopilotz } from "@copilotz/copilotz";

const copilotz = await createCopilotz({
  agents: [{
    id: "assistant",
    name: "Assistant",
    role: "assistant",
    instructions: "You are a helpful assistant. Remember what users tell you.",
    llmOptions: { provider: "openai", model: "gpt-4o-mini" },
  }],
  dbConfig: { url: ":memory:" },
});

// Start an interactive REPL — streams responses to stdout
copilotz.start({ banner: "🤖 Chat with your AI! Type 'quit' to exit.\n" });
```

Run it: `OPENAI_API_KEY=your-key deno run --allow-net --allow-env chat.ts`

### File-Based Resources

Organize agents, tools, and APIs in a directory structure — no giant config objects:

```typescript
import { createCopilotz } from "@copilotz/copilotz";

const copilotz = await createCopilotz({
  resources: { path: "./resources" },  // Loads agents/, tools/, apis/ automatically
  dbConfig: { url: Deno.env.get("DATABASE_URL") },
  stream: true,
});
```

### Usage and Cost Tracking

Copilotz records provider-native LLM usage when the upstream provider exposes it, and can estimate per-call cost using OpenRouter model pricing.

- Cost estimation is enabled by default with `llmOptions.estimateCost !== false`
- Use `llmOptions.pricingModelId` to override the OpenRouter model id when automatic mapping is not enough
- Cost is only estimated when usage came from the provider, not from Copilotz's rough fallback token heuristic
- Admin overview and admin agent summaries aggregate both token and cost totals from persisted `llm_usage` nodes

See the [copilotz-starter](https://github.com/copilotzhq/starter) template for a complete example.

### Programmatic Mode

For applications, use `run()` for full control:

```typescript
import { createCopilotz } from "@copilotz/copilotz";

const copilotz = await createCopilotz({
  agents: [{
    id: "assistant",
    name: "Assistant",
    role: "assistant",
    instructions: "You are a helpful assistant with a great memory.",
    llmOptions: { provider: "openai", model: "gpt-4o-mini" },
  }],
  dbConfig: { url: ":memory:" },
});

// First conversation
const result = await copilotz.run({
  content: "Hi! I'm Alex and I love hiking in the mountains.",
  sender: { type: "user", name: "Alex" },
});
await result.done;

// Later... your AI remembers
const result2 = await copilotz.run({
  content: "What do you know about me?",
  sender: { type: "user", name: "Alex" },
});
await result2.done;
// → "You're Alex, and you love hiking in the mountains!"

await copilotz.shutdown();
```

---

## Why Copilotz?

### Memory That Actually Works

Most AI frameworks give you chat history. Copilotz gives you a **knowledge graph** — users, conversations, documents, and entities all connected. Your AI doesn't just remember what was said; it understands relationships.

```typescript
// Entities are extracted automatically
await copilotz.run({ content: "I work at Acme Corp as a senior engineer" });

// Later, your AI knows:
// - User: Alex
// - Organization: Acme Corp  
// - Role: Senior Engineer
// - Relationship: Alex works at Acme Corp
```

### Tools That Do Things

27 built-in tools for file operations, HTTP requests, RAG, agent memory, and more. Plus automatic tool generation from OpenAPI specs and MCP servers.

```typescript
const copilotz = await createCopilotz({
  agents: [{
    // ...
    allowedTools: ["read_file", "write_file", "http_request", "search_knowledge"],
  }],
  apis: [{
    id: "github",
    openApiSchema: myOpenApiSchema,  // Object or JSON/YAML string
    auth: { type: "bearer", token: process.env.GITHUB_TOKEN },
  }],
});
```

### Multi-Tenant From Day One

Schema-level isolation for hard boundaries. Namespace-level isolation for logical partitioning. Your SaaS is ready for customers on day one.

```typescript
// Each customer gets complete isolation
await copilotz.run(message, onEvent, { 
  schema: "tenant_acme",      // PostgreSQL schema
  namespace: "workspace:123", // Logical partition
});
```

### Assets Without the Headache

When your tool generates an image or fetches a file, what happens next? With most frameworks, you're on your own. Copilotz automatically extracts assets from tool outputs, stores them, and resolves them for vision-capable LLMs.

```typescript
// Your tool just returns base64 data
const generateChart = {
  id: "generate_chart",
  execute: async ({ data }) => ({
    mimeType: "image/png",
    dataBase64: await createChart(data),
  }),
};

// Copilotz automatically:
// 1. Detects the asset in the tool output
// 2. Stores it (filesystem, S3, or memory)
// 3. Replaces it with an asset:// reference
// 4. Resolves it to a data URL for the next LLM call
// 5. Emits an ASSET_CREATED event for your hooks
```

Need finer control? Agents can opt out of persisting assets they generate via
`assetOptions.produce.persistGeneratedAssets = false`, which also sanitizes
inline base64/data URLs returned by their tool calls before persistence.

### Production Infrastructure, Not Prototypes

Event-driven architecture with persistent queues. Background workers for heavy processing. Custom processors for your business logic. This is infrastructure you'd build anyway — already built.

```typescript
// Events are persisted and recoverable
// Background jobs process RAG ingestion, entity extraction
// Custom processors extend the pipeline
const copilotz = await createCopilotz({
  // ...
  processors: [{
    eventType: "NEW_MESSAGE",
    shouldProcess: (event) => event.payload.needsApproval,
    process: async (event, deps) => {
      // Your custom logic here
      return { producedEvents: [] };
    },
  }],
});
```

---

## What's Included

### Skills & Admin Agent
SKILL.md files teach agents how to perform framework tasks. Progressive disclosure keeps prompts lean — only names and descriptions are loaded upfront; full instructions are fetched on-demand. A bundled admin agent uses skills to help you build agents, tools, and APIs interactively.

### Agents
Multi-agent orchestration with persistent targets, @mentions, loop prevention, and inter-agent communication. Agents can remember learnings across conversations with persistent memory.

### Collections
Type-safe data storage on top of the knowledge graph with JSON Schema validation.

### RAG Pipeline
Document ingestion → chunking → embeddings → semantic search. Works out of the box.

### Channels
Pre-built channel handlers for Web (SSE), WhatsApp Cloud API, and Zendesk Sunshine. Every channel is a single function with the same signature — framework-independent, no Oxian/Express/Hono lock-in.

```typescript
import { whatsappChannel } from "@copilotz/copilotz/server/channels/whatsapp";

// That's it. Wire to any framework:
const res = await whatsappChannel(
  { method: "POST", url, headers, body, rawBody },
  copilotz,
);
```

Config defaults to env vars (`WHATSAPP_*`, `ZENDESK_*`) or pass explicit config as a third argument. Available channels:

```typescript
import { webChannel } from "@copilotz/copilotz/server/channels/web";
import { whatsappChannel } from "@copilotz/copilotz/server/channels/whatsapp";
import { zendeskChannel } from "@copilotz/copilotz/server/channels/zendesk";
```

**Web** returns an async iterable of events for you to stream (SSE, WebSocket, etc.):

```typescript
const res = await webChannel(req, copilotz);
for await (const { event, data } of res.events!) {
  sse.send(data, { event });
}
```

**WhatsApp** and **Zendesk** handle the full lifecycle internally — verify the webhook, parse the payload, run the agent, and push responses back to the platform API.

### Streaming
Real-time token streaming with callbacks and async iterables.

### Assets
Automatic extraction and storage of images, files, and media from tool outputs. Seamless resolution for vision LLMs.

---

## Documentation

**Getting Started**
- [Quick Start](./docs/getting-started.md) — Install and run your first agent
- [Overview](./docs/overview.md) — Architecture and core concepts

**Core Concepts**
- [Agents](./docs/agents.md) — Multi-agent configuration and communication
- [Events](./docs/events.md) — Event-driven processing pipeline
- [Tools](./docs/tools.md) — Native tools, APIs, and MCP integration

**Data Layer**
- [Database](./docs/database.md) — PostgreSQL, PGLite, and the knowledge graph
- [Tables Structure](./docs/tables-structure.md) — Database schema reference
- [Collections](./docs/collections.md) — Type-safe data storage
- [RAG](./docs/rag.md) — Document ingestion and semantic search

**Advanced**
- [Skills](./docs/skills.md) — SKILL.md format, discovery, and admin agent
- [Configuration](./docs/configuration.md) — Full configuration reference
- [Assets](./docs/assets.md) — File and media storage
- [Loaders](./docs/loaders.md) — Load resources from filesystem
- [Server Helpers](./docs/server.md) — Framework-independent handler factories
- [Channels](./docs/channels.md) — Web, WhatsApp, and Zendesk channel handlers
- [API Reference](./docs/api-reference.md) — Complete API documentation

---

## Requirements

- Deno 2.0+
- PostgreSQL 13+ (production) or PGLite (development/embedded)
- LLM API key (OpenAI, Anthropic, Gemini, Groq, DeepSeek, or Ollama)

---

## License

MIT — see [LICENSE](./LICENSE)

---

<p align="center">
  <strong>Stop gluing. Start shipping.</strong>
</p>
