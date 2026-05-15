# App Dispatcher and Endpoints

`withApp(...)` attaches a framework-agnostic app dispatcher to a Copilotz
instance. That dispatcher maps runtime capabilities to HTTP-style resource
routes.

## What the Dispatcher Exposes

- threads
- messages
- collections
- assets
- graph
- events
- agents
- channels
- features

## Why It Matters

The app dispatcher gives you a stable contract that can be served by Oxian,
`deno.serve`, or another HTTP layer without rewriting core runtime logic.

## Example

```ts
const app = withApp(copilotz);

const result = await app.handle({
  resource: "features",
  method: "POST",
  path: ["auth", "login"],
  body: { email: "user@example.com" },
});
```

## Response Contract

The dispatcher returns `AppResponse`. HTTP adapters should serialize it as:

```json
{ "data": ... }
```

and include `pageInfo` when the route is paginated.

## Related Pages

- [withApp](../reference/with-app.md)
- [App Request and Response Contract](../reference/app-request-response-contract.md)
- [Build Backend Endpoints with Features](../playbooks/build-backend-endpoints-with-features.md)
