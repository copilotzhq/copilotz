# Test a Real Copilotz App

## When to Use This

Use this pattern when you want integration confidence across resource loading,
runtime wiring, and app contracts.

Recommended primitive: a real `createCopilotz(...)` instance plus `withApp(...)`  
Most common mistaken alternative: testing only mocked handlers or only isolated
functions

## Minimal Test Harness

```ts
const copilotz = withApp(await createCopilotz({
  dbConfig: { url: ":memory:" },
  resources: { path: ["./resources"] },
  namespace: "test-app",
}));
```

## Recommended Test Layers

- call `copilotz.app.handle(...)` to verify app routes and `{ data }` envelopes
- call loaded `tool.execute(...)` with a real `ToolExecutionContext` when you
  need tool-level assertions
- mock network-only dependencies such as `fetch`
- use real resource loading whenever you are validating framework wiring

## Public Example Focus

For app-level docs, follow the same runtime shape as `copilotz-starter`:

- bootstrap with `createCopilotz(...)`
- attach `withApp(...)`
- verify routes through the dispatcher

## Validation Checklist

- the test uses a real `resources.path`
- the app instance is namespaced
- feature routes resolve through `copilotz.app.handle(...)`
- collection routes persist and return expected data
- tool execution reads the same collections and thread state as the runtime

## Related Pages

- [Serve Copilotz with Oxian](./serve-copilotz-with-oxian.md)
- [withApp](../reference/with-app.md)
- [App Request and Response Contract](../reference/app-request-response-contract.md)
