---
title: Persist Data with Collections
description: Define typed application data and use it across app code, tools, features, and processors.
section: Build Guides
order: 50
status: draft
---

# Persist Data with Collections

Collections are Copilotz's application data primitive.

Use them for data your product owns: customers, bookings, projects, tasks,
preferences, profiles, orders, or any other app-specific entity.

## Define a Collection

```ts
import { defineCollection, index } from "@copilotz/copilotz";

export default defineCollection({
  name: "customer",
  schema: {
    type: "object",
    properties: {
      email: { type: "string" },
      name: { type: "string" },
      plan: { type: "string" },
    },
    required: ["email"],
  },
  indexes: [index("email")],
});
```

## Register It

```ts
const copilotz = await createCopilotz({
  agents: [agent],
  collections: [customer],
});
```

Or load it from `resources/collections`.

## Use It

```ts
const collections = copilotz.collections?.withNamespace("tenant-acme");

await collections?.customer.create({
  email: "gabi@example.com",
  name: "Gabi",
  plan: "pro",
});
```

## Related Pages

- [Data and Tenancy](../core-concepts/data-and-tenancy.md)
- [Collections](../resources/collections.md)
