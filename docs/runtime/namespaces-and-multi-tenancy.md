# Namespaces and Multi-Tenancy

Namespaces let Copilotz partition runtime state and data safely.

## What Namespaces Affect

- collection reads and writes
- participant identity resolution
- thread and event scoping
- asset references, depending on asset config

## Why This Matters

Most runtime bugs around "missing" data or incorrect cross-user visibility come
from using the wrong namespace or from mixing scoped and unscoped access.

## Recommended Use Case

Choose a namespace early and keep resource access scoped consistently.

## Common Mistaken Alternative

Do not pass around raw collection objects without being clear whether they are
scoped with `withNamespace(...)`.

## Related Pages

- [How Resource Loading Works](./how-resource-loading-works.md)
- [Collections API](../reference/collections-api.md)
- [Participant Collection](../reference/participant-collection.md)
