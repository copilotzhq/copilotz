---
title: Data and Tenancy
description: Collections, namespaces, and schemas give Copilotz apps persistent data and isolation.
section: Core Concepts
order: 70
status: stable
---

# Data and Tenancy

Copilotz applications need product data, conversation data, and tenant
isolation.

The framework gives you three main tools:

- collections for app-specific data
- namespaces for logical partitioning
- PostgreSQL schemas for stronger tenant isolation

## Collections

Collections are typed app data models. They expose CRUD operations and can be
used from app code, tools, features, and processors.

```ts
const customers = defineCollection({
  name: "customer",
  schema: {
    type: "object",
    properties: {
      email: { type: "string" },
      plan: { type: "string" },
    },
    required: ["email"],
  },
});
```

## Namespaces

Namespaces partition runtime data inside the same database schema.

Use namespaces for workspaces, tenants, environments, or users when shared
database structure is acceptable.

```ts
await copilotz.run(message, { namespace: "tenant-acme" });
```

## Schemas

PostgreSQL schemas provide stronger isolation. Use them when each tenant should
have separate database tables.

```ts
await copilotz.schema.provision("tenant_acme");
await copilotz.run(message, { schema: "tenant_acme" });
```

## Choosing Isolation

Use namespaces by default.

Use schemas when operational or compliance requirements need stronger
separation.

## Related Pages

- [Persist Data with Collections](../build-guides/persist-data-with-collections.md)
- [createCopilotz](../reference/create-copilotz.md)
