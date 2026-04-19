# Persist Data with Collections

## When to Use This

Use a `collection` when your app needs durable records with a typed schema,
queryable CRUD behavior, and optional route exposure through the app
dispatcher.

Recommended primitive: `collection`  
Most common mistaken alternative: storing durable records inside thread metadata

## Minimal Project Layout

```txt
resources/
  collections/
    customer.ts
```

## Example Implementation

```ts
import { defineCollection } from "copilotz";

export default defineCollection({
  name: "customer",
  schema: {
    type: "object",
    properties: {
      id: { type: "string" },
      email: { type: "string" },
      plan: { type: "string" },
    },
    required: ["id", "email"],
  },
  keys: [{ property: "id" }],
  indexes: ["email"],
});
```

## How Copilotz Consumes It

- resource loading merges custom collections with the built-in native ones
- the collections manager exposes CRUD access in code
- `withApp(...)` exposes the collection routes under `/collections/...`

## How It Maps to Endpoints

For a `customer` collection:

- `GET /collections/customer`
- `POST /collections/customer`
- `GET /collections/customer/:id`
- `PUT /collections/customer/:id`
- `DELETE /collections/customer/:id`

## Validation Checklist

- the collection is loaded into `copilotz.config.collections`
- the schema and keys match the intended route identity
- collection CRUD works through `copilotz.collections`
- app routes resolve through `/collections/<name>`
- durable app data does not leak into thread metadata

## Related Pages

- [Collections](../resources/collections.md)
- [Collections API](../reference/collections-api.md)
- [How the Graph Works](../runtime/how-the-graph-works.md)
