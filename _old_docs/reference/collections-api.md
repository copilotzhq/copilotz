# Collections API

The collections API is the main application-facing persistence API for durable
domain records.

## Main Access Paths

- `copilotz.collections`
- `copilotz.collections.withNamespace(...)`
- app routes under `/collections/...`

## Typical Operations

- `find`
- `findOne`
- `findById`
- `create`
- `update`
- `upsert`
- `delete`
- `search`

## Recommended Use Case

Use collections for durable app data with schemas and stable route contracts.

## Common Mistaken Alternative

Do not use collections as a replacement for thread-local metadata when the state
is only relevant to one conversation.

## Related Pages

- [Collections](../resources/collections.md)
- [Persist Data with Collections](../playbooks/persist-data-with-collections.md)
- [Namespaces and Multi-Tenancy](../runtime/namespaces-and-multi-tenancy.md)
