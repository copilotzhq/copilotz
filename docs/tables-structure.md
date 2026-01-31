# Tables Structure

This document describes the database tables used by Copilotz. The framework uses PostgreSQL (or PGLite) with a combination of relational tables and a knowledge graph.

## Overview

Copilotz maintains two types of storage:

1. **Relational Tables** — For core operational data (threads, events, documents)
2. **Knowledge Graph** — For interconnected data (nodes and edges)

```
┌─────────────────────────────────────────────────────────────┐
│                    Relational Tables                         │
├─────────────────────────────────────────────────────────────┤
│  threads     │  events      │  documents                    │
│  (active)    │  (queue)     │  (RAG metadata)               │
├─────────────────────────────────────────────────────────────┤
│                    Knowledge Graph                           │
├─────────────────────────────────────────────────────────────┤
│  nodes                      │  edges                         │
│  (messages, chunks, users,  │  (relationships between       │
│   entities, collections)    │   all node types)             │
└─────────────────────────────────────────────────────────────┘
```

---

## Core Tables

### threads

Conversation threads that group messages together.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `name` | TEXT | Optional thread name |
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

The event queue that powers Copilotz's event-driven architecture. Every action flows through this queue.

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
  type: "CUSTOM_EVENT",
  payload: { data: "..." },
  priority: 100,
  ttl: 60000,
});

// Get currently processing event
const item = await copilotz.ops.getProcessingQueueItem(threadId);

// Get next pending event
const next = await copilotz.ops.getNextPendingQueueItem(threadId, namespace);

// Update event status
await copilotz.ops.updateQueueItemStatus(eventId, "completed");
```

---

### documents

Metadata for documents ingested into the RAG pipeline.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `namespace` | TEXT | RAG namespace |
| `externalId` | TEXT | External identifier |
| `sourceType` | TEXT | `url`, `file`, `text` |
| `sourceUri` | TEXT | Source location |
| `title` | TEXT | Document title |
| `mimeType` | TEXT | Content type |
| `contentHash` | TEXT | SHA256 of content (deduplication) |
| `assetId` | TEXT | Associated asset ID |
| `status` | TEXT | `pending`, `processing`, `indexed`, `failed` |
| `chunkCount` | INTEGER | Number of chunks created |
| `errorMessage` | TEXT | Error details if failed |
| `metadata` | JSONB | Custom metadata |
| `createdAt` | TIMESTAMP | Creation time |
| `updatedAt` | TIMESTAMP | Last update time |

**Access:**

```typescript
// Create a document
const doc = await copilotz.ops.createDocument({
  source: "https://example.com/article.html",
  namespace: "docs",
  metadata: { category: "tutorials" },
});

// Get document by ID
const doc = await copilotz.ops.getDocumentById(documentId);

// Get document by content hash (for deduplication)
const existing = await copilotz.ops.getDocumentByHash(hash, namespace);

// Update document status
await copilotz.ops.updateDocumentStatus(
  documentId,
  "indexed",
  null,      // errorMessage
  15         // chunkCount
);

// Delete document (cascades to chunks)
await copilotz.ops.deleteDocument(documentId);

// Get namespace statistics
const stats = await copilotz.ops.getNamespaceStats();
// { "docs": { documentCount: 10, chunkCount: 500 }, ... }
```

---

## Knowledge Graph Tables

The knowledge graph is the primary storage layer for interconnected data. All messages, chunks, users, entities, and custom collections live here.

### nodes

Unified storage for all graph nodes.

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

| Type | Description | Created By |
|------|-------------|------------|
| `message` | Conversation messages | NEW_MESSAGE processor |
| `chunk` | Document chunks with embeddings | RAG_INGEST processor |
| `user` | User entities | Auto-upsert from messages |
| `entity` | Extracted entities | ENTITY_EXTRACT processor |
| `collection:*` | Custom collection records | Collections API |

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

// Semantic search
const results = await copilotz.ops.searchNodes({
  query: "technology companies in San Francisco",
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
  sourceId: messageId,
  targetId: entityId,
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

## Deprecated Tables

The following tables exist for backward compatibility but are being migrated to the knowledge graph:

### messages (Deprecated)

> **Use knowledge graph nodes instead.** Messages are now stored as nodes with `type: "message"`. The `messages` table is maintained for backward compatibility but new code should use the graph.

```typescript
// Old way (deprecated)
const messages = await copilotz.ops.crud.messages.find({ threadId });

// New way (recommended)
const history = await copilotz.ops.getMessageHistoryFromGraph(threadId, 50);
```

### users (Deprecated)

> **Use knowledge graph nodes instead.** Users are now stored as nodes with `type: "user"`. This enables graph-based queries and namespace scoping.

```typescript
// Old way (deprecated)
const user = await copilotz.ops.getUserByExternalId(externalId);

// New way (recommended)
const user = await copilotz.ops.getUserNode(externalId, namespace);
await copilotz.ops.upsertUserNode(externalId, namespace, { name: "Alex" });
```

### document_chunks (Deprecated)

> **Use knowledge graph nodes instead.** Chunks are now stored as nodes with `type: "chunk"`. This enables unified semantic search across all node types.

```typescript
// Old way (deprecated)
const chunks = await copilotz.ops.searchChunks({ query, namespace });

// New way (recommended)
const chunks = await copilotz.ops.searchChunksFromGraph({ query, namespace });
```

---

## Schema Isolation

For multi-tenant applications, each PostgreSQL schema contains a complete copy of all tables:

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
