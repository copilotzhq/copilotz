# Serve Copilotz with Oxian

## When to Use This

Use this pattern when you want the recommended public app path for Copilotz:
resource-driven runtime plus thin Oxian route handling.

Recommended primitive: `withApp(...)` behind Oxian routes  
Most common mistaken alternative: rebuilding Copilotz route dispatch manually in
every route file

## Public Example

`copilotz-starter/api/dependencies.ts` is the primary example:

```ts
const copilotz = await createCopilotz({
  resources: { path: ["./resources"] },
  namespace: "copilotz-starter",
});

const copilotzApp = withApp(copilotz);
```

Your Oxian route layer can then hand requests to the Copilotz app dispatcher or
to specific server handlers.

## How Copilotz Maps to Oxian

- Oxian owns HTTP routing, request parsing, and dependency injection
- Copilotz owns runtime execution, collections, threads, assets, and feature
  dispatch
- your route files should stay thin and framework-specific

## Validation Checklist

- `createCopilotz(...)` is built in the dependency layer
- `withApp(...)` is attached once
- Oxian routes forward the right method, resource, path, query, and body
- the response body preserves the `{ data }` contract

## Related Pages

- [Serve Copilotz with deno.serve](./serve-copilotz-with-deno-serve.md)
- [App Dispatcher and Endpoints](../runtime/app-dispatcher-and-endpoints.md)
- [withApp](../reference/with-app.md)
