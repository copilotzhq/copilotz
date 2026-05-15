# createCopilotz

`createCopilotz(...)` is the runtime bootstrap API.

## What It Does

- loads resources
- creates or attaches the database layer
- initializes collections, providers, storage, and runtime config
- returns a Copilotz instance you can run, inspect, or serve

## Common Inputs

- `dbConfig`
- `resources`
- `namespace`
- `agent`
- `assets`
- `multiAgent`
- `stream`

## Recommended Use Case

Use `createCopilotz(...)` once in your dependency/bootstrap layer and pass the
instance into the rest of your app.

## Common Mistaken Alternative

Do not instantiate ad hoc Copilotz instances deep inside route handlers.

## Related Pages

- [withApp](./with-app.md)
- [How Resource Loading Works](../runtime/how-resource-loading-works.md)
- [Serve Copilotz with Oxian](../playbooks/serve-copilotz-with-oxian.md)
