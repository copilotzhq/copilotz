# Database

Copilotz uses PostgreSQL as its data layer, with PGLite available for development and embedded use cases. The database stores events, threads, documents, and a knowledge graph that connects everything.

> For detailed schema documentation, see [Tables Structure](./tables-structure.md).

## Database Options

### PostgreSQL (Production)

```typescript
const copilotz = await createCopilotz({
  agents: [...],
  dbConfig: {
    url: "postgres://user:password@localhost:5432/copilotz",
    defaultSchema: "public",
    autoProvisionSchema: true,
  },
});
```

### PGLite (Development)

PGLite is a WebAssembly build of PostgreSQL that runs anywhere:

```typescript
// In-memory (fast, ephemeral)
dbConfig: { url: ":memory:" }

// File-based (persistent)
dbConfig: { url: "file:./data/copilotz.db" }
```

PGLite is great for:
- Local development
- Tests
- Embedded applications
- Edge deployments

## Configuration Options

```typescript
dbConfig: {
  url: "postgres://...",           // Connection URL
  defaultSchema: "public",         // Default PostgreSQL schema
  autoProvisionSchema: true,       // Auto-create schema on first use
  syncUrl: "postgres://...",       // Optional replication URL
  pgliteExtensions: [              // PGLite extensions to load
    "uuid_ossp", 
    "pg_trgm", 
    "vector"
  ],
  schemaSQL: "...",                // Extra SQL to run on init
  useWorker: false,                // Run PGLite in a worker
  logMetrics: false,               // Log database performance
}
```

## The Knowledge Graph

This is what makes Copilotz different from a simple chat database. Everything is connected in a graph:

```
                    ┌─────────────────┐
                    │     User        │
                    │  id: "alex"     │
                    └────────┬────────┘
                             │ SENT_BY
                             ▼
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│    Thread       │◀────│    Message      │────▶│    Entity       │
│  id: "t1"       │     │ "I work at..."  │     │  "Acme Corp"    │
└─────────────────┘     └────────┬────────┘     └─────────────────┘
                                 │ MENTIONS           ▲
                                 └────────────────────┘
```

### Node Types

| Type | Description |
|------|-------------|
| `user` | A user in the system |
| `message` | A conversation message |
| `document` | An ingested document |
| `chunk` | A piece of a document |
| `entity` | An extracted entity (person, company, concept) |
| `collection:*` | Custom collection records |

### Edge Types

| Type | Description |
|------|-------------|
| `SENT_BY` | Message → User |
| `MENTIONS` | Message → Entity |
| `NEXT_CHUNK` | Chunk → Chunk (document order) |
| `RELATED_TO` | Entity → Entity |
| `BELONGS_TO` | Collection relations |
| `HAS_MANY` | Collection relations |

### Graph Operations

```typescript
// Create a node
const node = await copilotz.ops.createNode({
  type: "entity",
  namespace: "default",
  properties: { name: "Acme Corp", type: "organization" },
});

// Create an edge
await copilotz.ops.createEdge({
  sourceId: messageId,
  targetId: node.id,
  type: "MENTIONS",
});

// Search nodes by embedding
const results = await copilotz.ops.searchNodes({
  query: "technology companies",
  namespace: "default",
  type: "entity",
  limit: 10,
});

// Traverse the graph
const related = await copilotz.ops.traverseGraph(
  nodeId,
  ["MENTIONS", "RELATED_TO"],
  3  // Max depth
);

// Get edges for a node
const edges = await copilotz.ops.getEdgesForNode(
  nodeId,
  "out",  // "in", "out", or "both"
  ["MENTIONS"]
);
```

## Multi-Tenancy

Copilotz supports two levels of data isolation:

### Schema Isolation

PostgreSQL schemas provide complete database-level separation:

```typescript
// Each tenant gets their own schema with all tables
await copilotz.schema.provision("tenant_acme");

// Run operations in a tenant's schema
await copilotz.run(message, onEvent, { schema: "tenant_acme" });
```

Schema operations:

```typescript
// Create a tenant schema
await copilotz.schema.provision("tenant_acme");

// Check if schema exists
const exists = await copilotz.schema.exists("tenant_acme");

// List all tenant schemas
const schemas = await copilotz.schema.list();

// Warm the schema cache (on startup)
await copilotz.schema.warmCache();

// Drop a tenant schema
await copilotz.schema.drop("tenant_old");
```

### Namespace Isolation

Namespaces provide logical partitioning within a schema:

```typescript
// Operations scoped to a namespace
await copilotz.run(message, onEvent, { namespace: "workspace:123" });

// Collections scoped to a namespace
const scoped = copilotz.collections.withNamespace("workspace:123");
```

### When to Use Which

| Use Case | Schema | Namespace |
|----------|--------|-----------|
| Complete data isolation | ✓ | |
| Regulatory compliance | ✓ | |
| Large tenants with many users | ✓ | |
| Workspaces within a tenant | | ✓ |
| Projects or folders | | ✓ |
| Lightweight partitioning | | ✓ |

You can combine both:

```typescript
await copilotz.run(message, onEvent, { 
  schema: "tenant_acme",       // Hard isolation
  namespace: "project:456",    // Logical partition
});
```

## The Ops API

Direct database access through `copilotz.ops`:

### Thread Operations

```typescript
// Find or create a thread
const thread = await copilotz.ops.findOrCreateThread(threadId, {
  metadata: { customerId: "c1" },
});

// Get thread by ID
const thread = await copilotz.ops.getThreadById(threadId);

// Get threads for a participant
const threads = await copilotz.ops.getThreadsForParticipant(userId);

// Archive a thread
await copilotz.ops.archiveThread(threadId, "Resolved: customer happy");
```

### Message Operations

Messages are stored in the knowledge graph as nodes. Use graph-based methods:

```typescript
// Get message history from knowledge graph (recommended)
const messages = await copilotz.ops.getMessageHistoryFromGraph(threadId, 50);

// Get last message node
const lastMessage = await copilotz.ops.getLastMessageNode(threadId);
```

### User Operations

Users are stored in the knowledge graph as nodes with namespace scoping:

```typescript
// Upsert a user node
await copilotz.ops.upsertUserNode("external-id", "tenant:acme", {
  name: "Alex",
  email: "alex@acme.com",
});

// Get a user node (checks namespace, falls back to global)
const user = await copilotz.ops.getUserNode("external-id", "tenant:acme");

// Get all user nodes for an external ID
const allUsers = await copilotz.ops.getUserNodesByExternalId("external-id");
```

### Queue Operations

```typescript
// Add to queue
await copilotz.ops.addToQueue(threadId, {
  type: "CUSTOM_EVENT",
  payload: { ... },
});

// Get processing item
const item = await copilotz.ops.getProcessingQueueItem(threadId);

// Update status
await copilotz.ops.updateQueueItemStatus(queueId, "completed");
```

### RAG Operations

```typescript
// Create a document
const doc = await copilotz.ops.createDocument({
  source: "https://...",
  namespace: "docs",
});

// Search chunks
const chunks = await copilotz.ops.searchChunks({
  query: "authentication setup",
  namespace: "docs",
  limit: 5,
});

// Get namespace stats
const stats = await copilotz.ops.getNamespaceStats();
// { "docs": { documentCount: 10, chunkCount: 500 } }
```

## Reusing a Database Instance

Share a database across multiple Copilotz instances:

```typescript
import { createDatabase } from "@copilotz/copilotz";

// Create database once
const db = await createDatabase({
  url: "postgres://...",
});

// Share across instances
const copilotz1 = await createCopilotz({
  agents: [...],
  dbInstance: db,
});

const copilotz2 = await createCopilotz({
  agents: [...],
  dbInstance: db,
});
```

## Next Steps

- [Tables Structure](./tables-structure.md) — Detailed database schema reference
- [Collections](./collections.md) — Type-safe data on the knowledge graph
- [RAG](./rag.md) — Document storage and retrieval
- [Configuration](./configuration.md) — Full database configuration
