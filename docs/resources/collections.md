# Collections

Collections define durable application data with schemas, keys, indexes, and
CRUD behavior.

## Where It Lives

```txt
resources/collections/<collection-name>.ts
```

## What It Is For

Use a collection for durable app records that belong to your domain.

Recommended use case: business data and app state  
Most common mistaken alternative: storing durable records in thread metadata

## How Copilotz Consumes It

- collections are loaded into the collections manager
- CRUD is available in app code, tools, features, and processors
- `withApp(...)` exposes collection routes automatically

## Minimal Example

```ts
import { defineCollection } from "copilotz";

export default defineCollection({
  name: "ticket",
  schema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  },
});
```

## Public Surface

Collections are reachable through `/collections/:name` plus the internal
collections manager API.

## Related Pages

- [Persist Data with Collections](../playbooks/persist-data-with-collections.md)
- [Collections API](../reference/collections-api.md)
- [How the Graph Works](../runtime/how-the-graph-works.md)
