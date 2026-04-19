# Architecture Overview

Copilotz applications have four layers:

1. resource declarations under `resources/`
2. the Copilotz runtime that loads and composes those resources
3. persistence and execution foundations such as graph, threads, and events
4. transport layers such as Oxian routes or `deno.serve`

## The Core Flow

1. You declare resources like agents, tools, features, collections, and
   processors.
2. `createCopilotz(...)` loads those resources and normalizes them into a single
   runtime config.
3. The runtime uses threads, events, the graph, collections, assets, and
   providers to execute work.
4. `withApp(...)` and the server helpers expose that runtime through application
   endpoints.

## Recommended Mental Model

- resources are the source of truth
- runtime composes resources into behavior
- threads hold conversation-local state
- collections hold durable app data
- participants represent durable identities
- features expose app endpoints
- tools expose agent-callable actions

## Common Mistaken Alternative

Do not design your app around custom route files first and then try to "plug in"
Copilotz later. The recommended flow is to decide which resource owns the
behavior and then expose it through the transport layer you need.

## Public Example

`copilotz-starter/api/dependencies.ts` shows the recommended bootstrap:

```ts
const copilotz = await createCopilotz({
  dbConfig: { url: Deno.env.get("DATABASE_URL") },
  resources: { path: ["./resources"] },
  namespace: "copilotz-starter",
});

const copilotzApp = withApp(copilotz);
```

## Related Pages

- [Resources Are the Foundation](./resources-are-the-foundation.md)
- [How Resource Loading Works](../runtime/how-resource-loading-works.md)
- [App Dispatcher and Endpoints](../runtime/app-dispatcher-and-endpoints.md)
