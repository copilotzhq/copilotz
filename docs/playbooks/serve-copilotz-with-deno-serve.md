# Serve Copilotz with deno.serve

## When to Use This

Use this pattern when you want a transport-agnostic or minimal HTTP layer
without Oxian.

Recommended primitive: `withApp(...)` plus a thin `deno.serve` adapter  
Most common mistaken alternative: assuming Copilotz requires a specific web
framework

## Minimal Example

```ts
const copilotz = withApp(await createCopilotz({
  dbConfig: { url: ":memory:" },
  resources: { path: ["./resources"] },
}));

Deno.serve(async (request) => {
  const url = new URL(request.url);
  const result = await copilotz.app.handle({
    resource: "features",
    method: "POST",
    path: ["auth", "login"],
    body: await request.json(),
  });
  return Response.json({ data: result.data }, { status: result.status });
});
```

## How Copilotz Maps to deno.serve

- `deno.serve` owns HTTP transport only
- you translate the HTTP request into `AppRequest`
- `copilotz.app.handle(...)` returns `AppResponse`
- your adapter serializes `{ data }` and status codes

## Validation Checklist

- the adapter forwards resource, method, and path correctly
- app responses are serialized as `{ data }`
- route-specific logic is kept in resources or runtime helpers, not in the HTTP
  glue

## Related Pages

- [Serve Copilotz with Oxian](./serve-copilotz-with-oxian.md)
- [App Request and Response Contract](../reference/app-request-response-contract.md)
- [withApp](../reference/with-app.md)
