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
- optional `context` for server-derived execution data

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
