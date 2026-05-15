# Namespaces and Multi-Tenancy

Namespaces let Copilotz partition runtime state and data safely.

In current Copilotz, `namespace` means the tenant/application/workspace
partition. It should not encode thread ids, agent ids, document groups, or RAG
search buckets. Those relationships live in fields and graph edges.

## What Namespaces Affect

- collection reads and writes
- participant identity resolution
- thread rows and event queue filtering
- graph node partitioning
- asset references, depending on asset config
- RAG document/chunk tenant isolation

## Why This Matters

Most runtime bugs around "missing" data or incorrect cross-user visibility come
from using the wrong namespace or from mixing scoped and unscoped access.

## Recommended Use Case

Choose a namespace early and keep resource access scoped consistently.

```ts
const copilotz = await createCopilotz({
  namespace: "tenant-acme",
  // ...
});

await copilotz.run(message, { namespace: "tenant-acme" });
```

For RAG, keep the same tenant namespace and use graph scopes for search
eligibility:

```ts
ragOptions: {
  mode: "auto",
  scope: {
    threadId,
    agentId: "support-agent",
    knowledgeSpaceIds: ["ks-support"],
  },
}
```

## Common Mistaken Alternative

Do not pass around raw collection objects without being clear whether they are
scoped with `withNamespace(...)`.

Do not create synthetic namespaces like `tenant:acme:thread:...` or
`tenant:acme:agent:...`. Use the tenant namespace plus graph edges instead.

## Related Pages

- [How Resource Loading Works](./how-resource-loading-works.md)
- [Collections API](../reference/collections-api.md)
- [Participant Collection](../reference/participant-collection.md)
