# Tables Structure

This document describes the database tables used by Copilotz. The framework uses PostgreSQL (or PGLite) with **four persisted tables** per schema: threads, events (queue), nodes, and edges.

## Overview

All conversational content, RAG material, users, entities, and custom collection records live in the **knowledge graph** (`nodes` + `edges`). **Threads** hold conversation metadata and grouping. **Events** are the durable work queue that drives processing.

```
┌─────────────────────────────────────────────────────────────┐
│  threads          │  events (queue)                          │
│  Conversation     │  NEW_MESSAGE, LLM_CALL, RAG_INGEST, …    │
│  metadata         │  status, payload, priority, TTL, …       │
├─────────────────────────────────────────────────────────────┤
│  nodes                              │  edges                 │
│  message, chunk, document, user,    │  REPLIED_BY, SENT_BY, │
│  entity, collection:*, …            │  NEXT_CHUNK, MENTIONS, …│
└─────────────────────────────────────────────────────────────┘
```

---

## Core Tables

### threads

Conversation threads: metadata, participants, hierarchy, and lifecycle (`active` / `archived`).

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `name` | TEXT | Thread name |
| `externalId` | TEXT | External system identifier |
| `description` | TEXT | Thread description |
| `participants` | JSONB | Array of participant IDs |
| `initialMessage` | TEXT | First message content |
| `mode` | TEXT | Thread mode |
| `status` | TEXT | `active`, `archived` |
| `summary` | TEXT | Summary (set when archived) |
| `parentThreadId` | UUID | Parent thread for hierarchies |
| `metadata` | JSONB | Custom metadata |
| `createdAt` | TIMESTAMP | Creation time |
| `updatedAt` | TIMESTAMP | Last update time |

**Access:**

```typescript
// Find or create a thread
const thread = await copilotz.ops.findOrCreateThread(threadId, {
  metadata: { customerId: "c1" },
});

// Get thread by ID
const thread = await copilotz.ops.getThreadById(threadId);

// Get thread by external ID
const thread = await copilotz.ops.getThreadByExternalId("external-123");

// Get threads for a participant
const threads = await copilotz.ops.getThreadsForParticipant(userId, {
  limit: 10,
  offset: 0,
});

// Archive a thread
await copilotz.ops.archiveThread(threadId, "Resolved: customer happy");
```

---

### events

The event queue powers Copilotz's event-driven architecture. Every action flows through this table.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `threadId` | UUID | Associated thread |
| `eventType` | TEXT | `NEW_MESSAGE`, `LLM_CALL`, `TOOL_CALL`, `RAG_INGEST`, `ENTITY_EXTRACT`, etc. |
| `payload` | JSONB | Event-specific data |
| `parentEventId` | UUID | Parent event (for chains) |
| `traceId` | UUID | Trace ID for debugging |
| `priority` | INTEGER | Higher = processed first |
| `ttlMs` | INTEGER | Time-to-live in milliseconds |
| `expiresAt` | TIMESTAMP | Expiration time |
| `namespace` | TEXT | Multi-tenancy namespace |
| `status` | TEXT | `pending`, `processing`, `completed`, `failed`, `expired`, `overwritten` |
| `metadata` | JSONB | Custom metadata |
| `createdAt` | TIMESTAMP | Creation time |
| `updatedAt` | TIMESTAMP | Last update time |

**Access:**

```typescript
// Add an event to the queue
await copilotz.ops.addToQueue(threadId, {
  eventType: "CUSTOM_EVENT",
  payload: { data: "..." },
  priority: 100,
  ttlMs: 60000,
});

// Get currently processing event
const item = await copilotz.ops.getProcessingQueueItem(threadId);

// Get next pending event
const next = await copilotz.ops.getNextPendingQueueItem(threadId, namespace);

// Update event status
await copilotz.ops.updateQueueItemStatus(eventId, "completed");
```

---

## Knowledge Graph Tables

### nodes

Unified storage for every graph node: messages, RAG documents and chunks, users, entities, and `collection:*` records.

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT (ULID) | Primary key |
| `namespace` | TEXT | Multi-tenancy namespace |
| `type` | TEXT | Node type (see below) |
| `name` | TEXT | Display name |
| `embedding` | VECTOR(1536) | Vector embedding for semantic search |
| `content` | TEXT | Text content |
| `data` | JSONB | Type-specific properties |
| `source_type` | TEXT | Source of this node |
| `source_id` | TEXT | Source identifier |
| `created_at` | TIMESTAMP | Creation time |
| `updated_at` | TIMESTAMP | Last update time |

**Built-in node types:**

| Type | Description | Typical producer |
|------|-------------|------------------|
| `message` | Conversation turns | NEW_MESSAGE / message pipeline |
| `document` | Ingested source metadata (URI, hash, status, title, …) | RAG_INGEST |
| `chunk` | Embedded text segments for retrieval | RAG_INGEST |
| `user` | End-user identity (often `data.externalId`) | Message / participant upserts |
| `entity` | Extracted entities | ENTITY_EXTRACT |
| `collection:*` | Collection-backed records | Collections API |

**RAG note:** There is no separate `documents` or `document_chunks` table. Ingestion creates a `document` node plus `chunk` nodes (and edges such as `NEXT_CHUNK`). High-level helpers like `createDocument`, `getDocumentById`, and `searchChunks` read and write these nodes.

**Access:**

```typescript
// Create a node
const node = await copilotz.ops.createNode({
  type: "entity",
  namespace: "tenant:acme",
  name: "Acme Corp",
  content: "Acme Corporation is a technology company...",
  data: { entityType: "organization", industry: "technology" },
});

// Create multiple nodes
const nodes = await copilotz.ops.createNodes([...]);

// Get node by ID
const node = await copilotz.ops.getNodeById(nodeId);

// Get nodes by namespace and type
const entities = await copilotz.ops.getNodesByNamespace("tenant:acme", "entity");

// Update a node
await copilotz.ops.updateNode(nodeId, {
  data: { ...existingData, newField: "value" },
});

// Delete a node
await copilotz.ops.deleteNode(nodeId);

// Semantic search over stored embeddings (pass a vector; use chunk search + embedder for NL queries)
const results = await copilotz.ops.searchNodes({
  embedding: embeddingVector,
  nodeTypes: ["entity"],
  namespaces: ["tenant:acme"],
  limit: 10,
  minSimilarity: 0.7,
});
```

---

### edges

Relationships between nodes.

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT (ULID) | Primary key |
| `source_node_id` | TEXT | Source node ID (FK) |
| `target_node_id` | TEXT | Target node ID (FK) |
| `type` | TEXT | Edge type (see below) |
| `data` | JSONB | Edge properties |
| `weight` | FLOAT | Edge weight/strength |
| `created_at` | TIMESTAMP | Creation time |

**Built-in edge types:**

| Type | From → To | Description |
|------|-----------|-------------|
| `REPLIED_BY` | Message → Message | Conversation flow |
| `SENT_BY` | User → Message | Message authorship |
| `MENTIONS` | Message/Chunk → Entity | Entity references in content |
| `RELATED_TO` | Entity → Entity | Entity relationships |
| `NEXT_CHUNK` | Chunk → Chunk | Sequential document chunks |
| `BELONGS_TO` | Node → Node | Custom collection relations |
| `HAS_MANY` | Node → Node | Custom collection relations |
| `HAS_ONE` | Node → Node | Custom collection relations |

**Access:**

```typescript
// Create an edge
await copilotz.ops.createEdge({
  sourceNodeId: messageId,
  targetNodeId: entityId,
  type: "MENTIONS",
  data: { confidence: 0.95 },
});

// Create multiple edges
await copilotz.ops.createEdges([...]);

// Get edges for a node
const outgoing = await copilotz.ops.getEdgesForNode(nodeId, "out");
const incoming = await copilotz.ops.getEdgesForNode(nodeId, "in");
const all = await copilotz.ops.getEdgesForNode(nodeId, "both", ["MENTIONS"]);

// Delete an edge
await copilotz.ops.deleteEdge(edgeId);

// Delete all edges for a node
await copilotz.ops.deleteEdgesForNode(nodeId);

// Traverse the graph
const { nodes, edges } = await copilotz.ops.traverseGraph(
  startNodeId,
  ["MENTIONS", "RELATED_TO"],  // Edge types to follow
  3                             // Max depth
);

// Find related nodes
const related = await copilotz.ops.findRelatedNodes(nodeId, 2);
```

---

## Messages and participants

Messages are **`nodes` with `type: "message"`**, linked with edges (for example `REPLIED_BY`, `SENT_BY`). Use graph-oriented APIs:

```typescript
const history = await copilotz.ops.getMessageHistoryFromGraph(threadId, 50);
const last = await copilotz.ops.getLastMessageNode(threadId);
await copilotz.ops.createMessage(messageInput, namespace);
```

Participants (humans and agents) are represented as graph nodes; use `upsertParticipantNode` / `getParticipantNode` (or legacy `upsertUserNode` / `getUserNode` where still exposed).

---

## Schema Isolation

For multi-tenant applications, each PostgreSQL schema contains the same four tables (`threads`, `events`, `nodes`, `edges`):

```typescript
// Provision a tenant schema
await copilotz.schema.provision("tenant_acme");

// Run operations in a tenant's schema
await copilotz.run(message, callback, { schema: "tenant_acme" });
```

See [Database](./database.md) for more on multi-tenancy.

---

## Next Steps

- [Collections](./collections.md) — Type-safe data storage on the knowledge graph
- [Database](./database.md) — Database configuration and multi-tenancy
- [API Reference](./api-reference.md) — Full ops API documentation
