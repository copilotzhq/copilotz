# Collections

Collections are type-safe data storage built on top of the knowledge graph. Define a schema, and you get CRUD operations, relations, semantic search, and lifecycle hooks — all with TypeScript inference.

## Why Collections?

Your AI application needs to store more than just conversations:

- **Customer records** with plans, preferences, and history
- **Support tickets** with status, priority, and assignments
- **Product catalogs** with categories and relationships

Collections give you:
- **Type safety** — TypeScript knows your data shape
- **Schema validation** — Catch errors before they hit the database
- **Semantic search** — Find records by meaning, not just fields
- **Relations** — Connect records with edges in the knowledge graph
- **Lifecycle hooks** — Transform data on create, update, delete

## Defining a Collection

```typescript
import { defineCollection, relation, index } from "@copilotz/copilotz";

const customer = defineCollection({
  name: "customer",
  schema: {
    type: "object",
    properties: {
      id: { type: "string" },
      email: { type: "string", format: "email" },
      name: { type: "string" },
      plan: { type: "string", enum: ["free", "pro", "enterprise"] },
      metadata: { type: "object" },
    },
    required: ["id", "email"],
  } as const,  // Important: use 'as const' for type inference
  indexes: [
    index.field("email"),
    index.field("plan"),
  ],
  relations: {
    account: relation.belongsTo("account", "accountId"),
    tickets: relation.hasMany("ticket", "customerId"),
  },
});
```

### Schema

Collections use JSON Schema for validation:

```typescript
schema: {
  type: "object",
  properties: {
    id: { type: "string" },
    email: { type: "string", format: "email" },
    age: { type: "number", minimum: 0 },
    tags: { type: "array", items: { type: "string" } },
    active: { type: "boolean", default: true },
  },
  required: ["id", "email"],
}
```

### Indexes

Speed up queries with indexes:

```typescript
indexes: [
  index.field("email"),              // B-tree index on email
  index.field("createdAt"),          // B-tree index on createdAt
  index.fulltext("description"),     // Full-text search index
]
```

### Relations

Connect collections with relations:

```typescript
relations: {
  // This customer belongs to an account
  account: relation.belongsTo("account", "accountId"),
  
  // This customer has many tickets
  tickets: relation.hasMany("ticket", "customerId"),
  
  // This customer has one profile
  profile: relation.hasOne("profile", "customerId"),
}
```

Relations create edges in the knowledge graph, enabling graph traversal.

## Registering Collections

Pass collections to `createCopilotz`:

```typescript
const copilotz = await createCopilotz({
  agents: [...],
  collections: [customer, account, ticket],
  collectionsConfig: {
    autoIndex: true,        // Create indexes on startup
    validateOnWrite: true,  // Validate against schema on write
  },
});
```

## Using Collections

All collection operations require a namespace. Use explicit namespaces or create a scoped manager.

### Explicit Namespace

```typescript
// Create
await copilotz.collections.customer.create(
  { id: "c1", email: "alex@acme.com", name: "Alex", plan: "pro" },
  { namespace: "tenant:acme" }
);

// Read
const customer = await copilotz.collections.customer.findById(
  "c1",
  { namespace: "tenant:acme" }
);

// Update
await copilotz.collections.customer.update(
  { id: "c1" },
  { plan: "enterprise" },
  { namespace: "tenant:acme" }
);

// Delete
await copilotz.collections.customer.delete(
  { id: "c1" },
  { namespace: "tenant:acme" }
);
```

### Scoped Namespace

Create a scoped manager to avoid repeating the namespace:

```typescript
const scoped = copilotz.collections.withNamespace("tenant:acme");

// All operations use "tenant:acme" automatically
await scoped.customer.create({ id: "c1", email: "alex@acme.com" });
await scoped.customer.findById("c1");
await scoped.customer.update({ id: "c1" }, { plan: "pro" });
```

## CRUD Operations

### Create

```typescript
// Single record
const customer = await collections.customer.create({
  id: "c1",
  email: "alex@acme.com",
  name: "Alex",
  plan: "free",
});

// Multiple records
const customers = await collections.customer.createMany([
  { id: "c1", email: "alex@acme.com" },
  { id: "c2", email: "sam@acme.com" },
]);
```

### Find

```typescript
// Find by ID
const customer = await collections.customer.findById("c1");

// Find one matching filter
const customer = await collections.customer.findOne({ email: "alex@acme.com" });

// Find all matching filter
const proCustomers = await collections.customer.find({ plan: "pro" });

// With query operators
const customers = await collections.customer.find({
  plan: { $in: ["pro", "enterprise"] },
  createdAt: { $gt: "2024-01-01" },
});
```

### Query Operators

| Operator | Description |
|----------|-------------|
| `$eq` | Equal to |
| `$ne` | Not equal to |
| `$gt` | Greater than |
| `$gte` | Greater than or equal |
| `$lt` | Less than |
| `$lte` | Less than or equal |
| `$in` | In array |
| `$nin` | Not in array |
| `$like` | SQL LIKE pattern |
| `$ilike` | Case-insensitive LIKE |

### Update

```typescript
// Update matching filter
await collections.customer.update(
  { id: "c1" },           // Filter
  { plan: "pro" }         // Updates
);

// Update multiple
await collections.customer.updateMany(
  { plan: "free" },
  { plan: "legacy" }
);

// Upsert (create or update)
await collections.customer.upsert(
  { id: "c1", email: "alex@acme.com", plan: "pro" }
);
```

### Delete

```typescript
// Delete matching filter
await collections.customer.delete({ id: "c1" });

// Delete multiple
await collections.customer.deleteMany({ plan: "legacy" });
```

### Count & Exists

```typescript
// Count matching records
const count = await collections.customer.count({ plan: "pro" });

// Check if exists
const exists = await collections.customer.exists({ email: "alex@acme.com" });
```

## Semantic Search

If embeddings are configured, collections support semantic search:

```typescript
// Search by meaning
const results = await collections.customer.search({
  query: "enterprise customers in tech industry",
  limit: 10,
  threshold: 0.7,
});

// Find similar records
const similar = await collections.customer.findSimilar(customerId, {
  limit: 5,
});
```

## Lifecycle Hooks

Transform data or trigger side effects:

```typescript
const customer = defineCollection({
  name: "customer",
  schema: { ... },
  hooks: {
    beforeCreate: async (data, context) => {
      // Normalize email
      return { ...data, email: data.email.toLowerCase() };
    },
    afterCreate: async (record, context) => {
      // Send welcome email
      await sendWelcomeEmail(record.email);
    },
    beforeUpdate: async (filter, updates, context) => {
      // Add updated timestamp
      return { ...updates, updatedAt: new Date().toISOString() };
    },
    afterUpdate: async (record, context) => {
      // Sync to external system
      await syncToExternalCRM(record);
    },
    beforeDelete: async (filter, context) => {
      // Prevent deletion of admin accounts
      const record = await context.findOne(filter);
      if (record?.role === "admin") {
        throw new Error("Cannot delete admin accounts");
      }
    },
    afterDelete: async (record, context) => {
      // Cleanup related data
      await cleanupCustomerData(record.id);
    },
  },
});
```

## Built-in Data Structures

Copilotz uses its own internal data structures that you can access via `copilotz.ops`. Understanding these helps you build on top of the framework.

For detailed documentation of all database tables, see [Tables Structure](./tables-structure.md).

### Knowledge Graph Node Types

The knowledge graph (`nodes` table) stores these built-in node types:

| Node Type | Purpose | Created By |
|-----------|---------|------------|
| `message` | Conversation messages | `NEW_MESSAGE` processor |
| `chunk` | Document chunks with embeddings | `RAG_INGEST` processor |
| `user` | User entities | Message processing (auto-upsert) |
| `entity` | Extracted entities (people, orgs, concepts) | `ENTITY_EXTRACT` processor |

**Message nodes:**
```typescript
{
  type: "message",
  namespace: threadId,          // Scoped to thread
  content: "Hello, world!",
  data: {
    messageId: "...",
    senderId: "user-123",
    senderType: "user",
    toolCalls: [...],
    metadata: {...},
  },
}
```

**Chunk nodes:**
```typescript
{
  type: "chunk",
  namespace: "docs",            // RAG namespace
  content: "Document text...",
  embedding: [0.1, 0.2, ...],   // Vector embedding
  data: {
    documentId: "...",
    chunkIndex: 0,
    tokenCount: 150,
  },
}
```

**User nodes:**
```typescript
{
  type: "user",
  namespace: null,              // null = global user
  name: "Alex",
  data: {
    externalId: "user-123",
    email: "alex@acme.com",
    isGlobal: true,
    metadata: {...},
  },
}
```

**Entity nodes:**
```typescript
{
  type: "entity",               // Or "person", "organization", "concept", etc.
  namespace: "thread:123",
  name: "Acme Corp",
  data: {
    aliases: ["Acme", "Acme Corporation"],
    mentionCount: 5,
    entityType: "organization",
  },
}
```

### Knowledge Graph Edge Types

Edges connect nodes in the graph:

| Edge Type | From → To | Purpose |
|-----------|-----------|---------|
| `REPLIED_BY` | Message → Message | Conversation flow |
| `SENT_BY` | User → Message | Message authorship |
| `MENTIONS` | Message/Chunk → Entity | Entity references |
| `RELATED_TO` | Entity → Entity | Entity relationships |
| `NEXT_CHUNK` | Chunk → Chunk | Document order |
| `BELONGS_TO` | Collection → Collection | Custom relations |
| `HAS_MANY` | Collection → Collection | Custom relations |

Query edges via `copilotz.ops`:

```typescript
// Get all entities mentioned in a message
const mentions = await copilotz.ops.getEdgesForNode(messageId, "out", ["MENTIONS"]);

// Get all messages from a user
const messages = await copilotz.ops.getEdgesForNode(userId, "out", ["SENT_BY"]);

// Traverse relationships
const related = await copilotz.ops.traverseGraph(entityId, ["MENTIONS", "RELATED_TO"], 3);
```

### Accessing Built-in Data

Use `copilotz.ops` for high-level operations:

```typescript
// Thread operations
const thread = await copilotz.ops.findOrCreateThread(threadId, { metadata: {...} });
const history = await copilotz.ops.getMessageHistory(threadId, userId, 50);
await copilotz.ops.archiveThread(threadId, "Resolved successfully");

// User operations (graph-based)
await copilotz.ops.upsertUserNode("external-123", "tenant:acme", { name: "Alex" });
const user = await copilotz.ops.getUserNode("external-123", "tenant:acme");

// Graph operations
const nodes = await copilotz.ops.searchNodes({
  query: "enterprise customers",
  nodeTypes: ["entity"],
  namespace: "tenant:acme",
});

// RAG operations
const stats = await copilotz.ops.getNamespaceStats();
// { "docs": { documentCount: 10, chunkCount: 500 } }
```

---

## Custom Collections in the Knowledge Graph

When you define a custom collection, records become nodes in the knowledge graph:

```
┌─────────────────┐
│    Customer     │
│   id: "c1"      │
│   email: ...    │
└────────┬────────┘
         │ BELONGS_TO
         ▼
┌─────────────────┐
│    Account      │
│   id: "a1"      │
└────────┬────────┘
         │ HAS_MANY
         ▼
┌─────────────────┐
│    Ticket       │
│   id: "t1"      │
└─────────────────┘
```

This enables graph queries across collections:

```typescript
// Find all entities related to a customer
const related = await copilotz.ops.traverseGraph(customerId, ["BELONGS_TO", "HAS_MANY"], 2);
```

Your custom collections live alongside the built-in node types, all queryable through the same graph API.

---

## Next Steps

- [Database](./database.md) — Understanding the knowledge graph
- [RAG](./rag.md) — Semantic search integration
- [Configuration](./configuration.md) — Collection configuration options
