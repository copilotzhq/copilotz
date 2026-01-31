# Overview

Copilotz is a full-stack framework for building AI applications. This document explains the core architecture and how the pieces fit together.

## The Big Picture

Most AI frameworks focus on one thing: calling an LLM. Copilotz handles the entire application stack:

```
┌─────────────────────────────────────────────────────────────┐
│                        Your Application                      │
├─────────────────────────────────────────────────────────────┤
│  Agents          │  Tools           │  Collections          │
│  Multi-agent     │  23 native       │  Type-safe            │
│  orchestration   │  OpenAPI, MCP    │  data storage         │
├─────────────────────────────────────────────────────────────┤
│                     Event Processing                         │
│  Queue → Processors → Workers → Callbacks                    │
├─────────────────────────────────────────────────────────────┤
│                     Knowledge Graph                          │
│  Users ↔ Messages ↔ Documents ↔ Entities ↔ Chunks           │
├─────────────────────────────────────────────────────────────┤
│                     PostgreSQL / PGLite                      │
│  Threads │ Messages │ Queue │ Nodes │ Edges │ Documents     │
└─────────────────────────────────────────────────────────────┘
```

## Core Concepts

### Agents

Agents are the actors in your AI application. Each agent has:

- **Identity**: A unique ID and name
- **Instructions**: System prompt defining behavior
- **LLM Configuration**: Which model to use and how
- **Permissions**: Which tools and other agents it can access
- **RAG Settings**: How to use the knowledge base

Agents can talk to each other using `@mentions`, ask questions to other agents, and collaborate on complex tasks.

```typescript
const agent = {
  id: "support-agent",
  name: "Support",
  instructions: "You help customers with their questions.",
  llmOptions: { provider: "openai", model: "gpt-4o-mini" },
  allowedTools: ["search_knowledge", "create_ticket"],
  allowedAgents: ["escalation-agent"],
};
```

### Events

Everything in Copilotz is an event. When a user sends a message, it becomes a `NEW_MESSAGE` event. That event might produce an `LLM_CALL` event, which might produce `TOOL_CALL` events, and so on.

**Why events?**
- **Persistence**: Events are stored in the database, so nothing is lost
- **Observability**: You can see exactly what happened and when
- **Extensibility**: Add custom processors to handle new event types
- **Reliability**: Failed events can be retried

Core event types:
- `NEW_MESSAGE` — A message entered the system
- `LLM_CALL` — Time to call an LLM
- `TOOL_CALL` — Execute a tool
- `TOKEN` — A streaming token (not persisted)
- `RAG_INGEST` — Ingest a document
- `ENTITY_EXTRACT` — Extract entities from content

### Knowledge Graph

This is what makes Copilotz different. Instead of just storing chat history, everything becomes nodes in a graph:

- **Users** are nodes
- **Messages** are nodes connected to users and threads
- **Documents** are nodes, with chunks as child nodes
- **Entities** (people, companies, concepts) are nodes extracted from conversations

The graph enables queries like:
- "What entities has this user mentioned?"
- "What documents are related to this topic?"
- "What's the conversation history with context?"

```
User:Alex ──SENT_BY──▶ Message:"I work at Acme"
                              │
                              ▼
                        Entity:Acme Corp
                              │
                        ◀──MENTIONS──
```

### Collections

Collections are a typed layer on top of the knowledge graph. Define a schema, and you get type-safe CRUD operations:

```typescript
const customer = defineCollection({
  name: "customer",
  schema: {
    type: "object",
    properties: {
      id: { type: "string" },
      email: { type: "string" },
      plan: { type: "string" },
    },
  },
});

// Type-safe operations
await copilotz.collections.customer.create({ id: "1", email: "alex@acme.com" });
await copilotz.collections.customer.find({ plan: "pro" });
```

### Tools

Tools let your agents interact with the world. Copilotz includes 23 native tools and can generate more from OpenAPI specs and MCP servers.

**Native tools include:**
- File operations: `read_file`, `write_file`, `list_directory`, `search_files`
- HTTP: `http_request`, `fetch_text`
- RAG: `search_knowledge`, `ingest_document`, `list_namespaces`
- System: `run_command`, `get_current_time`, `wait`
- Agent: `ask_question`, `create_thread`, `end_thread`
- Assets: `save_asset`, `fetch_asset`

### Multi-Tenancy

Copilotz supports two levels of isolation:

**Schema isolation** (PostgreSQL schemas):
- Complete database-level separation
- Each tenant has their own tables
- Use for hard isolation requirements

**Namespace isolation** (within a schema):
- Logical partitioning of data
- Faster and lighter than schemas
- Use for workspaces, projects, or logical groups

```typescript
// Schema isolation
await copilotz.run(message, callback, { schema: "tenant_acme" });

// Namespace isolation
await copilotz.run(message, callback, { namespace: "workspace:123" });

// Both together
await copilotz.run(message, callback, { 
  schema: "tenant_acme", 
  namespace: "project:456" 
});
```

## Request Lifecycle

Here's what happens when you call `copilotz.run()`:

```
1. Message received
   └─▶ NEW_MESSAGE event created and queued

2. Message processor runs
   ├─▶ Message persisted to database + knowledge graph
   ├─▶ Target agents discovered (mentions, thread participants)
   ├─▶ RAG context injected (if enabled)
   └─▶ LLM_CALL event emitted

3. LLM processor runs
   ├─▶ LLM called with context, tools, history
   ├─▶ TOKEN events streamed (if streaming enabled)
   ├─▶ Tool calls extracted
   └─▶ TOOL_CALL events emitted (if tools called)

4. Tool processor runs (for each tool call)
   ├─▶ Tool executed (native, API, or MCP)
   └─▶ NEW_MESSAGE event with result

5. Cycle continues until LLM produces final response
   └─▶ NEW_MESSAGE with assistant response

6. Background processing
   ├─▶ ENTITY_EXTRACT for entity recognition
   └─▶ Knowledge graph updated
```

## Next Steps

- [Getting Started](./getting-started.md) — Install and run your first agent
- [Agents](./agents.md) — Configure agents and multi-agent systems
- [Events](./events.md) — Understand the event processing pipeline
- [Database](./database.md) — Set up PostgreSQL and understand the data model
