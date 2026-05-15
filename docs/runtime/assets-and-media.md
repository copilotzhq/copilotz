---
title: Assets and Media
description: How Copilotz stores, references, and resolves files and generated media.
section: Runtime
order: 50
status: draft
---

# Assets and Media

Copilotz treats files and generated media as first-class runtime data.

Assets can come from:

- user attachments
- tool outputs
- generated media
- persisted files fetched later by clients or models

## Asset References

Stored assets use references like:

```txt
asset://<asset-id>
```

The runtime can resolve asset references for model calls and expose asset
helpers through `copilotz.assets`.

## Storage

Copilotz supports memory, filesystem, passthrough, and S3-compatible asset
storage.

```ts
const copilotz = await createCopilotz({
  agents: [agent],
  assets: {
    config: {
      backend: "fs",
      rootDir: "./.copilotz/assets",
    },
  },
});
```

## Events

Asset handling can emit:

- `ASSET_CREATED`
- `ASSET_ERROR`

## Related Pages

- [Events](../core-concepts/events.md)
- [Providers and Storage](../resources/providers-and-storage.md)
