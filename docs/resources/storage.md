# Storage Adapters

Storage adapters define where Copilotz stores assets and related binary data.

## Where It Lives

```txt
resources/storage/<adapter-name>/
```

## What It Is For

Use a storage adapter when asset bytes, media, or files need to persist outside
regular collection records.

Recommended use case: asset persistence  
Most common mistaken alternative: stuffing binary payloads directly into
collection metadata

## How Copilotz Consumes It

- storage adapters are loaded into the asset storage registry
- runtime asset helpers call the configured backend
- asset references can be passed back into LLM and app flows

## Minimal Example

The built-in `fs` and `s3` adapters under `resources/storage/` are the canonical
examples.

## Public Surface

Storage adapters are consumed through asset APIs and runtime storage behavior,
not as standalone endpoints.

## Related Pages

- [Assets and Media](../runtime/assets-and-media.md)
- [createCopilotz](../reference/create-copilotz.md)
- [Serve Copilotz with Oxian](../playbooks/serve-copilotz-with-oxian.md)
