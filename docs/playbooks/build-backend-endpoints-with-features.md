# Build Backend Endpoints with Features

## When to Use This

Use a `feature` when your frontend or another backend service should call a
Copilotz-backed action directly over an app endpoint.

Recommended primitive: `feature`  
Most common mistaken alternative: implementing app-facing backend behavior as a
`tool` first

## Minimal Project Layout

```txt
resources/
  features/
    auth/
      login.ts
      register.ts
```

## Example Implementation

```ts
export default async function loginFeature(request, copilotz) {
  const body = request.body ?? {};
  return {
    data: {
      message: "Logged in",
      email: body.email,
    },
  };
}
```

## How Copilotz Consumes It

- `createCopilotz({ resources: { path } })` loads `resources/features/...`
- `withApp(copilotz)` registers each `feature/action` pair under the app
  dispatcher
- the feature becomes reachable at `/features/:feature/:action`

## How It Maps to Endpoints

With `withApp(...)`, this file:

```txt
resources/features/auth/login.ts
```

maps to:

```txt
POST /features/auth/login
```

The app response contract is serialized as `{ data: ... }`.

## Public Example

`copilotz-starter` shows the recommended runtime bootstrap in
`api/dependencies.ts`, where `createCopilotz(...)` and `withApp(...)` are wired
together. Your Oxian route or `deno.serve` handler only needs to forward the
request to `copilotz.app.handle(...)`.

## Validation Checklist

- the feature file lives under `resources/features/<name>/<action>.ts`
- `withApp(copilotz)` is attached before the transport layer handles requests
- `POST /features/<name>/<action>` resolves through the app dispatcher
- the response shape is `{ data: ... }`
- no custom route duplicates the same business logic unnecessarily

## Related Pages

- [Features](../resources/features.md)
- [App Dispatcher and Endpoints](../runtime/app-dispatcher-and-endpoints.md)
- [Feature Handler Contract](../reference/feature-handler-contract.md)
