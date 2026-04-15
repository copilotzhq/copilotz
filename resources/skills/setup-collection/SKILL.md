---
name: setup-collection
description: Define a typed collection with JSON Schema validation and indexes for application data.
allowed-tools: [read_file, write_file, list_directory]
tags: [framework, data, collection]
---

# Setup Collection

Collections provide type-safe CRUD over the knowledge graph with JSON Schema validation.

## Define a Collection

Collections are defined in code and passed to `createCopilotz`:

```typescript
import { defineCollection, index, relation } from "copilotz";

const customer = defineCollection({
    name: "customer",
    schema: {
        type: "object",
        properties: {
            id: { type: "string" },
            email: { type: "string" },
            name: { type: "string" },
            plan: { type: "string", enum: ["free", "pro", "enterprise"] },
        },
        required: ["id", "email"],
    } as const,
    indexes: [
        index.field("email"),
        index.fulltext("name"),
    ],
    relations: {
        tickets: relation.hasMany("ticket", "customerId"),
    },
});
```

## Use in createCopilotz

```typescript
const copilotz = await createCopilotz({
    agents: [...],
    collections: [customer],
    collectionsConfig: {
        autoIndex: true,
        validateOnWrite: true,
    },
    dbConfig: { url: "..." },
});
```

## CRUD Operations

```typescript
// Create
await copilotz.collections.customer.create({ id: "1", email: "a@b.com", name: "Alice", plan: "pro" });

// Read
const item = await copilotz.collections.customer.findOne({ id: "1" });
const all = await copilotz.collections.customer.find({ plan: "pro" });

// Update
await copilotz.collections.customer.update({ id: "1" }, { plan: "enterprise" });

// Delete
await copilotz.collections.customer.delete({ id: "1" });

// Search (semantic)
const results = await copilotz.collections.customer.search("enterprise customers");
```

## With Namespaces (Multi-tenancy)

```typescript
const scoped = copilotz.collections.withNamespace("tenant:acme");
await scoped.customer.create({ ... });
```

## Notes

- Collections map to graph nodes internally
- `index.field()` for equality lookups, `index.fulltext()` for text search
- Agents can interact with collections via the collection tools or custom tools
