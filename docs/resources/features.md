# Features

Features are app-facing backend actions loaded from `resources/features/...`.

## Where It Lives

```txt
resources/features/<feature-name>/<action>.ts
```

## What It Is For

Use a feature when application code should call the behavior directly through an
endpoint.

Recommended use case: frontend-facing or service-facing backend action  
Most common mistaken alternative: implementing app contracts as tools

## How Copilotz Consumes It

- features are loaded during `createCopilotz(...)`
- `withApp(...)` registers them as app routes
- each feature action is reachable as `/features/:feature/:action`

## Minimal Example

```ts
export default async function register(request, copilotz) {
  return { data: { ok: true } };
}
```

## Public Surface

Features become dispatcher endpoints under the `features` resource family.

## Related Pages

- [Build Backend Endpoints with Features](../playbooks/build-backend-endpoints-with-features.md)
- [Feature Handler Contract](../reference/feature-handler-contract.md)
- [App Dispatcher and Endpoints](../runtime/app-dispatcher-and-endpoints.md)
