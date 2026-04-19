# withApp

`withApp(...)` attaches the framework-agnostic app dispatcher to a Copilotz
instance.

## What It Adds

- `app.handle(...)`
- dispatcher-backed resources and routes
- a transport-independent app contract you can serve through Oxian or another
  HTTP layer

## Recommended Use Case

Use `withApp(...)` when your application needs endpoint-style access to Copilotz
runtime capabilities.

## Common Mistaken Alternative

Do not rebuild feature, collection, or thread route dispatch manually if the app
dispatcher already matches your needs.

## Related Pages

- [App Dispatcher and Endpoints](../runtime/app-dispatcher-and-endpoints.md)
- [App Request and Response Contract](./app-request-response-contract.md)
- [Serve Copilotz with deno.serve](../playbooks/serve-copilotz-with-deno-serve.md)
