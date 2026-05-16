---
title: "Ch 18: Collections — Application Data"
description: "Your business entities, stored in the same database as your agent."
section: Getting Started
order: 180
status: stable
---

# Chapter 18: Collections — Application Data

> **Part 7 — Production Patterns**

## The pain

Your agent is in production. Conversations are happening. But the actual business entities your product manages — customers, tickets, orders, support cases — live in a separate database with its own connection, its own ORM, and its own migration history.

Every tool that touches your data bridges two worlds. You query Postgres for the customer record, pass it to the agent, get a response, and write back. If the tool needs context from the conversation (thread ID, namespace, agent state), you stitch it in manually. When a tenant's data needs to stay isolated, you enforce it yourself.

There's a simpler path. Your agent already has a database. It already handles multi-tenancy. It already knows the current namespace. You can put your application data there too.

## The solution

Collections are typed, namespace-scoped application data living in the same database as your agent. You define a schema, register the collection, and the framework gives you:

- Full CRUD — create, find, findById, update, delete
- Full-text and semantic search
- Relations between collections (edges in the knowledge graph)
- Multi-tenancy with zero extra work
- A complete REST API from the server facade — no extra routes to write

Chapter 12 introduced collections through the knowledge graph lens — entities extracted from conversations. This chapter is about something different: using collections as your primary application data layer. Customers. Tickets. Products. Whatever your product manages.

## Defining collections

```typescript
import { createCopilotz, defineCollection, relation } from "@copilotz/copilotz";

const customerSchema = {
  type: "object",
  properties: {
    id:        { type: "string", readOnly: true },
    name:      { type: "string" },
    email:     { type: "string" },
    plan:      { type: "string", enum: ["free", "pro", "enterprise"] },
    createdAt: { type: "string", format: "date-time", readOnly: true },
    updatedAt: { type: "string", format: "date-time", readOnly: true },
  },
  required: ["name", "email", "plan"],
} as const;

const customers = defineCollection({
  name: "customer",
  schema: customerSchema,
  indexes: ["email", "plan"],
  search: { enabled: true, fields: ["name", "email"] },
});

const ticketSchema = {
  type: "object",
  properties: {
    id:         { type: "string", readOnly: true },
    title:      { type: "string" },
    status:     { type: "string", enum: ["open", "in_progress", "resolved"] },
    priority:   { type: "string", enum: ["low", "medium", "high"] },
    customerId: { type: "string" },
    createdAt:  { type: "string", format: "date-time", readOnly: true },
    updatedAt:  { type: "string", format: "date-time", readOnly: true },
  },
  required: ["title", "status", "priority"],
} as const;

const tickets = defineCollection({
  name: "ticket",
  schema: ticketSchema,
  indexes: ["status", "priority", "customerId"],
  search: { enabled: true, fields: ["title"] },
  relations: {
    customer: relation.belongsTo("customer", "customerId"),
  },
});

const copilotz = await createCopilotz({
  agents: [{ id: "support", name: "Support Agent", role: "...", llmOptions: { ... } }],
  collections: [customers, tickets],
  dbConfig: { url: "postgresql://user:pass@localhost/myapp" },
});
```

## CRUD

```typescript
const db = copilotz.collections.withNamespace("acme");

// Create
const customer = await db.customer.create({
  name: "Acme Corp",
  email: "billing@acme.com",
  plan: "enterprise",
});

// Create a related record — edge created automatically
const ticket = await db.ticket.create({
  title: "Login page broken after update",
  status: "open",
  priority: "high",
  customerId: customer.id,
});

// Find with filter
const openTickets = await db.ticket.find({ status: "open" });

// Find with relation populated
const ticketWithCustomer = await db.ticket.findById(
  ticket.id,
  { populate: ["customer"] }
);
console.log(ticketWithCustomer.customer.name); // "Acme Corp"

// Full-text search
const results = await db.ticket.search("login");

// Update
await db.ticket.update({ id: ticket.id }, { status: "in_progress" });

// Delete
await db.ticket.delete({ id: ticket.id });
```

## Collections as file resources

For larger projects, define each collection in `resources/collections/`:

```typescript
// resources/collections/customer.ts
import { defineCollection } from "@copilotz/copilotz";

export default defineCollection({
  name: "customer",
  schema: { ... } as const,
  indexes: ["email", "plan"],
  search: { enabled: true, fields: ["name", "email"] },
});
```

Copilotz auto-loads them when `resources.path` is set — no registration needed.

## The server facade gives you REST for free

Once collections are registered and you use `withApp()`, every collection has a complete REST API at `collections/:name`. No extra routes to write.

```
GET    /api/collections/customer           → list (with filter, sort, pagination)
POST   /api/collections/customer           → create
GET    /api/collections/customer/:id       → get by ID
PUT    /api/collections/customer/:id       → update
DELETE /api/collections/customer/:id       → delete
GET    /api/collections/customer?q=acme    → full-text search
```

All of these are dispatched through `app.handle()`:

```typescript
// List customers on pro or enterprise plan, sorted by name
const response = await app.handle({
  resource: "collections",
  method: "GET",
  path: ["customer"],
  query: {
    filter: JSON.stringify({ plan: "enterprise" }),
    sort: "name:asc",
    limit: "20",
    populate: "customer",
  },
  context: { namespace: "acme" },
});
// response.data → paginated list of customers
// response.pageInfo → { total, limit, offset, hasMore }
```

Query parameters supported:

| Parameter | Example | What it does |
|---|---|---|
| `filter` | `{"status":"open"}` | JSON filter object |
| `sort` | `name:asc,createdAt:desc` | Comma-separated field:direction |
| `limit` | `20` | Page size |
| `offset` | `40` | Skip N records |
| `before` / `after` | cursor ID | Cursor-based pagination |
| `populate` | `customer,assignee` | Relations to traverse |
| `q` | `login broken` | Full-text search (replaces filter) |

## Using collections from tools

Your custom tools receive the namespace via `context` and can access collections directly:

```typescript
const lookupCustomerTool = {
  key: "lookup_customer",
  name: "Lookup Customer",
  description: "Find a customer and their open tickets by email.",
  inputSchema: {
    type: "object",
    properties: { email: { type: "string" } },
    required: ["email"],
  },
  execute: async ({ email }, context) => {
    const db = copilotz.collections.withNamespace(context.namespace ?? "main");

    const matches = await db.customer.find({ email });
    if (matches.length === 0) return { found: false };

    const customer = matches[0];
    const openTickets = await db.ticket.find({
      customerId: customer.id,
      status: "open",
    });

    return { customer, openTickets };
  },
};
```

The agent can now look up customers mid-conversation, see their open tickets, and act on them — all in the same namespace as the conversation itself.

## What this unlocks

- Your business entities and agent conversations in one database — same connection, same namespace, same API
- A complete REST API for every collection, served by the server facade with zero extra code
- Relations between entities (and between entities and RAG documents) via the knowledge graph
- Full-text and semantic search on any collection
- Namespace-scoped — data stays isolated across tenants automatically

## What's next

Collections give you persistent, typed data. But your product also needs custom server logic — a webhook to receive Stripe events, an admin endpoint to run reports, an internal API to trigger agent runs programmatically. Writing a separate server for that is overhead you don't need.

→ **[Chapter 19: Features — Custom Server Logic](./19-features-custom-server-logic.md))**
