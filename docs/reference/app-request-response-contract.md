# App Request and Response Contract

The app dispatcher uses `AppRequest` and `AppResponse` as its framework-neutral
contract.

## AppRequest

Key fields include:

- `resource`
- `method`
- `path`
- `query`
- `body`
- `headers`
- optional `context` for server-derived execution data, including
  `context.namespace` when the tenant/application namespace comes from auth or
  request context

Native app routes resolve the tenant namespace from `context.namespace`,
`withApp(..., { resolveNamespace })`, or `CopilotzConfig.namespace`. Do not pass
tenant namespace as a collection query parameter.

## AppResponse

Key fields include:

- `status`
- `data`
- `pageInfo` for paginated responses

## HTTP Serialization

HTTP adapters should serialize `AppResponse` as:

```json
{ "data": ... }
```

and include `pageInfo` when present.

## Related Pages

- [withApp](./with-app.md)
- [Build Backend Endpoints with Features](../playbooks/build-backend-endpoints-with-features.md)
- [Test a Real Copilotz App](../playbooks/test-a-real-copilotz-app.md)
