---
name: create-storage-adapter
description: Add a custom asset storage backend for files, media, and binary data.
allowed-tools: [read_file, write_file, list_directory]
tags: [framework, storage, assets]
---

# Create Storage Adapter

Use a storage adapter when asset bytes, media, or other binary data should
persist outside normal collection records.

## When To Use It

- Use a custom storage adapter for non-built-in asset persistence backends.
- Prefer the built-in `fs` and `s3` adapters when they already match your
  environment.
- Do not stuff binary payloads into collection metadata.

## Directory Structure

```txt
resources/storage/{adapter-name}/
  adapter.ts
```

Also declare the adapter in `resources/manifest.ts`:

```typescript
export default {
  provides: {
    storage: ["my-backend"],
  },
};
```

## Step 1: Create `adapter.ts`

```typescript
export interface MyConnector {
  writeFile(path: string, data: Uint8Array): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  exists(path: string): Promise<boolean>;
  remove(path: string): Promise<void>;
}

export function createMyConnector(config: { bucket: string }): MyConnector {
  return {
    async writeFile(path, data) {
      console.log("write", path, data.length, config.bucket);
    },
    async readFile(_path) {
      return new Uint8Array();
    },
    async exists(_path) {
      return false;
    },
    async remove(path) {
      console.log("remove", path);
    },
  };
}

export default createMyConnector;
```

## Step 2: Configure The Backend

```typescript
assets: {
  config: {
    backend: "my-backend",
  },
}
```

## How Copilotz Consumes It

- storage adapters are loaded into the asset storage registry
- runtime asset helpers call the configured backend
- asset references can flow back into app, tool, and LLM behavior

## Common Mistakes

- Treating storage as an application endpoint instead of a runtime backend
- Saving large binary blobs directly into ordinary graph records
- Forgetting to declare the adapter in the resource manifest

## Notes

- The built-in `fs` and `s3` adapters are the canonical examples.
- Keep storage adapters focused on persistence semantics rather than business
  logic.
