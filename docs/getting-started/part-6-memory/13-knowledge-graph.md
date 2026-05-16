# Chapter 13: Knowledge Graph Collections

> **Part 6 — Memory & Knowledge**

## The pain

RAG is great for factual lookup. But it breaks down on relational questions.

"Find all documents about authentication" — RAG handles this fine.  
"Who is the owner of the authentication service?" — RAG might find a document that mentions it, but only if the exact phrasing matches.  
"List all services owned by engineers who joined in Q1" — RAG can't answer this at all. It doesn't know about relationships.

A vector database stores blobs of text and their similarity scores. It has no concept of "Alice *works on* Project X" or "Service Y *depends on* Service Z." For relationship-aware queries, you need a graph.

But graph databases are a separate, heavyweight system — a new query language to learn, a new server to operate, a new integration to maintain.

## The solution

Copilotz's knowledge graph is already there. It's what RAG uses to store document chunks. The underlying tables — `knowledge_nodes` and `knowledge_edges` — are a general-purpose graph store. The **Collections API** gives you a clean, type-safe interface on top of it.

Every collection is a type of graph node. Relations between collections are edges. You get a proper knowledge graph with the same database you're already using.

## Defining a collection

Relations are declared using the `relation` helper. The supported types are `hasMany` and `belongsTo` — the two sides of a foreign-key relationship. Edges between nodes are created automatically when a record with a `belongsTo` foreign key is inserted.

```typescript
import { createCopilotz, defineCollection, relation } from "@copilotz/copilotz";

// Define your schema using JSON Schema
const employeeSchema = {
  type: "object",
  properties: {
    id:         { type: "string", readOnly: true },
    name:       { type: "string" },
    email:      { type: "string" },
    department: { type: "string" },
    role:       { type: "string" },
    managerId:  { type: "string" },             // Foreign key for the manager relation
    startDate:  { type: "string", format: "date" },
    createdAt:  { type: "string", format: "date-time", readOnly: true },
    updatedAt:  { type: "string", format: "date-time", readOnly: true },
  },
  required: ["name", "email"],
} as const;  // "as const" is required for type inference

const employees = defineCollection({
  name: "employee",
  schema: employeeSchema,
  indexes: ["email", "department", "managerId"],
  search: { enabled: true, fields: ["name", "email", "role"] },
  relations: {
    manages:       relation.hasMany("employee", "managerId"),    // Manager → reports
    manager:       relation.belongsTo("employee", "managerId"),  // Report → manager
    ownedProjects: relation.hasMany("project", "ownerId"),       // Employee → projects they own
  },
});

const projectSchema = {
  type: "object",
  properties: {
    id:          { type: "string", readOnly: true },
    name:        { type: "string" },
    status:      { type: "string", enum: ["active", "completed", "paused"] },
    ownerId:     { type: "string" },
    createdAt:   { type: "string", format: "date-time", readOnly: true },
  },
  required: ["name", "status"],
} as const;

const projects = defineCollection({
  name: "project",
  schema: projectSchema,
  indexes: ["status", "ownerId"],
  relations: {
    owner: relation.belongsTo("employee", "ownerId"),  // Project → owning employee
  },
});
```

Register them with Copilotz:

```typescript
const copilotz = await createCopilotz({
  agents: [...],
  collections: [employees, projects],
  dbConfig: { url: "postgresql://user:pass@localhost/myapp" },
});
```

## CRUD operations

The collections API is type-safe — types are inferred from your JSON Schema:

```typescript
// Get type-safe accessors (namespace-scoped)
const db = copilotz.collections.withNamespace("main");

// Create
const bob = await db.employee.create({
  name: "Bob Lee",
  email: "bob@company.com",
  department: "Engineering",
  role: "Engineering Manager",
});

// Create a direct report — managerId creates the edge automatically
const alice = await db.employee.create({
  name: "Alice Chen",
  email: "alice@company.com",
  department: "Engineering",
  role: "Senior Engineer",
  managerId: bob.id,
});

// Read by ID
const employee = await db.employee.findById(alice.id);

// Update by filter
await db.employee.update({ id: alice.id }, { role: "Staff Engineer" });

// Find with filters
const engineers = await db.employee.find({ department: "Engineering" });

// Full-text search (requires search: { enabled: true })
const results = await db.employee.search("Alice");

// Count
const total = await db.employee.count({ department: "Engineering" });

// Delete by filter
await db.employee.delete({ id: alice.id });
```

## Working with relationships

Edges are created automatically — no separate API call needed. When you create a record that has a `belongsTo` relation and set the foreign key, Copilotz writes the edge immediately. To traverse relations, pass `populate` in the query options:

```typescript
// Create a project owned by Alice.
// The "owner" belongsTo relation uses ownerId as its foreign key,
// so the edge alice → authService is created automatically on insert.
const authService = await db.project.create({
  name: "Auth Service Redesign",
  status: "active",
  ownerId: alice.id,
});

// Query: who owns the auth service project? Traverse the belongsTo edge.
const projectWithOwner = await db.project.findById(
  authService.id,
  { populate: ["owner"] }
);
console.log(projectWithOwner.owner.name); // "Alice Chen"

// Query: which projects does Alice own? Traverse the hasMany edge.
const aliceWithProjects = await db.employee.find(
  { id: alice.id },
  { populate: ["ownedProjects"] }
);
console.log(aliceWithProjects[0].ownedProjects); // [{ name: "Auth Service Redesign", ... }]

// The manager hierarchy works the same way.
// Alice was created with managerId: bob.id, so bob's "manages" edge already exists.
const bobWithTeam = await db.employee.find(
  { id: bob.id },
  { populate: ["manages"] }
);
console.log(bobWithTeam[0].manages); // [{ name: "Alice Chen", ... }]
```

## Using collections from within tools

Your custom tools can access collections via the Copilotz database:

```typescript
const lookupProjectsTool = {
  key: "lookup_projects",
  name: "Lookup Projects",
  description: "Find projects by status or owner.",
  inputSchema: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["active", "completed", "paused"] },
      ownerEmail: { type: "string" },
    },
  },
  execute: async ({ status, ownerEmail }, context) => {
    const db = copilotz.collections.withNamespace(context.namespace ?? "main");

    if (ownerEmail) {
      const owners = await db.employee.find({ email: ownerEmail });
      if (owners.length === 0) return { projects: [] };
      return { projects: await db.project.find({ ownerId: owners[0].id }) };
    }

    return { projects: await db.project.find({ status }) };
  },
};
```

## Collections as resource files

Define collections in `resources/collections/` for auto-loading:

```typescript
// resources/collections/employee.ts
import { defineCollection } from "@copilotz/copilotz";

export default defineCollection({
  name: "employee",
  schema: { ... } as const,
  // ...
});
```

## The graph underneath

Under the hood, each collection record is a `knowledge_node` with:
- `id` — ULID
- `type` — the collection name
- `data` — your record data (JSONB)
- `embedding` — optional vector embedding for semantic search
- `namespace` — tenant partition

Relations between collections are `knowledge_edges`:
- `fromNodeId` — source node
- `toNodeId` — target node
- `relation` — edge type (your relation name)
- `namespace` — tenant partition

This means your custom data participates in the same graph as RAG documents and automatically extracted entities. You can query across all of them.

## What this unlocks

- Type-safe application data storage alongside agent data
- Relationship-aware queries — traverse the graph, not just match flat records
- Full-text and semantic search on any collection
- Multi-tenant data isolation via namespaces (more on this in Chapter 16)
- Your data and the agent's memory in the same store

## What's next

The knowledge graph is powerful, but right now you're populating it manually — ingesting documents, creating records, defining relations. What if the graph could grow automatically, directly from the conversations your agents have? Enter graph memory.

→ **[Chapter 14: Graph Memory](./14-graph-memory.md))**
