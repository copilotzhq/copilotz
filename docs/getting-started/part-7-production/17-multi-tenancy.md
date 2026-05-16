---
title: "Ch 17: Multi-Tenancy"
description: "Namespace isolation, per-tenant config, and scoped data access."
section: Getting Started
order: 170
status: stable
---

# Chapter 17: Multi-Tenancy

> **Part 7 — Production Patterns**

## The pain

You're building a B2B product. Acme Corp and Globex both use your agent. They're in the same database, using the same code.

Here's the nightmare: a bug in your namespace handling means Acme's support agent can retrieve Globex's customer records. Or Globex's conversation history shows up in Acme's threads. Or — worst — a system prompt injection in one tenant's conversation leaks another tenant's data to the LLM.

Multi-tenancy implemented as an afterthought is a security incident waiting to happen. Data isolation needs to be the default, not the exception — enforced at the infrastructure level, not just in your WHERE clauses.

## The solution

Copilotz has two levels of tenant isolation built in:

1. **Schema isolation** — each tenant gets their own PostgreSQL schema, with completely separate tables
2. **Namespace isolation** — logical partitioning within a schema, useful for workspaces or sub-tenants

Both are enforced by the framework. You pass an override to `run()` and the isolation is automatic.

## Schema isolation (strongest)

A PostgreSQL schema is like a separate namespace inside the database. Each tenant gets their own `threads`, `messages`, `events`, `knowledge_nodes`, and `knowledge_edges` tables. There is no possible query that crosses schema boundaries by accident.

```typescript
import { createCopilotz } from "@copilotz/copilotz";

const copilotz = await createCopilotz({
  agents: [...],
  dbConfig: {
    url: "postgresql://user:pass@db.myapp.com/saas",
    // Schemas are auto-provisioned on first use
  },
  // ...
});

// Provision schemas for new tenants
await copilotz.schema.provision("tenant_acme");
await copilotz.schema.provision("tenant_globex");

// Check if a schema exists
const exists = await copilotz.schema.exists("tenant_acme");  // true

// List all schemas
const all = await copilotz.schema.list();
// ["public", "tenant_acme", "tenant_globex"]
```

Pass the schema per request:

```typescript
// Acme's request — all data isolated to tenant_acme schema
const result = await copilotz.run(
  { content: "...", sender: { type: "user", name: "Acme User" } },
  { schema: "tenant_acme" }
);

// Globex's request — completely separate tables
const result2 = await copilotz.run(
  { content: "...", sender: { type: "user", name: "Globex User" } },
  { schema: "tenant_globex" }
);
```

The data never touches. Even if your application code had a bug that mixed tenant IDs, the database would reject cross-schema queries.

## Namespace isolation (logical)

Namespaces partition data *within* a schema. Useful for workspaces, projects, or environments inside a single tenant:

```typescript
// Same tenant (tenant_acme), different workspace
const workspace_a = await copilotz.run(
  { content: "...", sender: { type: "user", name: "Alice" } },
  { schema: "tenant_acme", namespace: "workspace-engineering" }
);

const workspace_b = await copilotz.run(
  { content: "...", sender: { type: "user", name: "Bob" } },
  { schema: "tenant_acme", namespace: "workspace-marketing" }
);
```

Collection queries are automatically scoped:

```typescript
const db = copilotz.collections.withNamespace("workspace-engineering");
const customers = await db.customer.find();
// Only returns customers in workspace-engineering namespace
```

## A complete multi-tenant SaaS pattern

Here's how you'd wire this up in an HTTP handler:

```typescript
import { createCopilotz } from "@copilotz/copilotz";
import { Hono } from "npm:hono";

const copilotz = await createCopilotz({
  agents: [...],
  dbConfig: { url: Deno.env.get("DATABASE_URL") },
  // ...
});

const app = new Hono();

// Middleware: resolve tenant from JWT or session
app.use("/api/*", async (c, next) => {
  const token = c.req.header("Authorization")?.replace("Bearer ", "");
  const tenant = await resolveTenantFromToken(token);

  if (!tenant) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  c.set("tenantSchema", `tenant_${tenant.id}`);
  c.set("tenantNamespace", tenant.workspaceId);
  await next();
});

// Chat endpoint — automatically isolated per tenant
app.post("/api/chat", async (c) => {
  const schema = c.get("tenantSchema");
  const namespace = c.get("tenantNamespace");

  // Provision schema if this is a new tenant (idempotent)
  if (!(await copilotz.schema.exists(schema))) {
    await copilotz.schema.provision(schema);
  }

  const body = await c.req.json();

  const result = await copilotz.run(
    {
      content: body.message,
      sender: { type: "user", externalId: body.userId, name: body.userName },
    },
    {
      schema,      // All data goes to this tenant's schema
      namespace,   // Further partitioned by workspace
      threadId: body.threadId,
    }
  );

  return c.streamText(async (stream) => {
    for await (const event of result.events) {
      await stream.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    await stream.write("data: [DONE]\n\n");
  });
});
```

## Isolation levels compared

| | No isolation | Namespace only | Schema isolation |
|--|--|--|--|
| Data mixing possible | Yes | No (by convention) | No (enforced by DB) |
| Cross-tenant query risk | High | Low | None |
| Resource overhead | None | None | One schema per tenant |
| Supports PGlite | Yes | Yes | No (PostgreSQL only) |
| When to use | Dev/single-tenant | Workspaces within tenant | B2B, compliance-sensitive |

## Warm cache on startup

For applications with many tenants, warm the schema cache at startup to avoid per-request provision checks:

```typescript
await copilotz.schema.warmCache();
```

This loads all existing schema names into memory so `schema.exists()` doesn't hit the database on every request.

## Offboarding tenants

Drop a schema to permanently remove all of a tenant's data:

```typescript
// WARNING: This permanently deletes all tenant data
await copilotz.schema.drop("tenant_acme");
```

Always confirm this action before executing. There is no undo.

## What this unlocks

- B2B SaaS without a data isolation incident
- One deployment serves thousands of tenants
- Schema-level isolation enforced by PostgreSQL — not by your WHERE clauses
- Namespace partitioning for workspaces within a tenant
- Auto-provisioning — new tenant, one call, isolated environment ready

## What's next

You now have a production-grade, multi-tenant system. The next frontier: what happens when a single agent isn't enough? Some tasks require expertise that one generalist agent can't provide. You need teams of specialized agents that can collaborate, delegate, and divide work.

→ **[Chapter 18: Collections — Application Data](./18-collections-application-data.md))**
