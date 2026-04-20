# Feature Handler Contract

A feature action is a function loaded from:

```txt
resources/features/<feature>/<action>.ts
```

## Handler Shape

The default export receives:

- a request-like object with `method`, `body`, `query`, `headers`, and optional `context`
- the Copilotz instance

## Return Shape

Feature handlers may return:

- an object with `status` and `data`
- or a value that the dispatcher wraps as `data`

## Recommended Use Case

Use a feature handler for app-facing backend actions with a clear request and
response contract.

## Common Mistaken Alternative

Do not hide application endpoints inside tools unless the model needs to decide
when to call them.

## Related Pages

- [Features](../resources/features.md)
- [Build Backend Endpoints with Features](../playbooks/build-backend-endpoints-with-features.md)
- [withApp](./with-app.md)
