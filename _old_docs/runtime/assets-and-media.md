# Assets and Media

Assets let Copilotz persist and reference binary content such as images and
files without forcing that content into ordinary collection records.

## What Assets Do

- store bytes through a configured storage backend
- return asset references the runtime can resolve
- support media-aware application and LLM flows

## Recommended Use Case

Use assets when the payload is binary or should be resolved through asset
storage semantics.

## Common Mistaken Alternative

Do not store large file payloads directly inside collection metadata or thread
metadata.

## Public Surface

Assets are exposed through the app layer and through the runtime asset store.

## Related Pages

- [Storage Adapters](../resources/storage.md)
- [createCopilotz](../reference/create-copilotz.md)
- [Serve Copilotz with Oxian](../playbooks/serve-copilotz-with-oxian.md)
