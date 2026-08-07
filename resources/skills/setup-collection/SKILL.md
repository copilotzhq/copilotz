---
name: setup-collection
description: Define a typed graph collection and expose it through a plugin.
allowed-tools: [read_file, write_file, list_directory]
tags: [framework, data, collection, plugin]
---

# Setup Collection

Every collection mutation updates graph state, appends its immutable semantic
event, and creates matching durable delivery obligations in one transaction.

```ts
import {
  defineCollection,
  index,
  relation,
} from "jsr:@copilotz/copilotz@3/domain";
import { definePlugin } from "jsr:@copilotz/copilotz@3/plugins";

const customer = defineCollection({
  name: "customer",
  schema: {
    type: "object",
    properties: {
      email: { type: "string" },
      name: { type: "string" },
      plan: { type: "string", enum: ["free", "pro", "enterprise"] },
    },
    required: ["email", "name", "plan"],
    additionalProperties: false,
  } as const,
  indexes: [index.unique("email"), index.field("plan")],
  relations: {
    tickets: relation.hasMany("ticket", "customerId"),
  },
  hooks: {
    beforeCreate(input) {
      return { ...input, email: String(input.email).trim().toLowerCase() };
    },
  },
});

export default definePlugin({
  manifest: {
    id: "@acme/customer-domain",
    version: "1.0.0",
    provides: { collections: [customer.name] },
  },
  resources: { collections: [customer] },
});
```

## Application access

```ts
const customers = app.collections.get("customer");
const created = await customers.create({
  email: "alice@example.com",
  name: "Alice",
  plan: "pro",
}, { namespace: "acme" });

const alice = created.value;
const listed = await customers.list("acme", { where: { plan: "pro" } });
```

Inside a processor, use `context.collections.customer`; it is already scoped to
the delivery namespace and accepts stable `operationKey` values for retry
deduplication.

Only `beforeCreate`, `beforeUpdate`, and `beforeDelete` hooks may validate or
transform the atomic write. Put all post-write behavior in named processors.
Never bypass collections with raw graph or SQL mutations.
