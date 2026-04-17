# Storage

Copilotz uses a storage backend for assets — images, files, and media produced by tool calls or uploaded by users. Built-in backends are filesystem (`fs`) and Amazon S3 (`s3`).

## Default Behavior

By default, assets are stored on the local filesystem under a configurable root directory. No setup is required for development:

```typescript
const copilotz = await createCopilotz({
  agents: [{ id: "assistant", instructions: "..." }],
  dbConfig: { url: ":memory:" },
  // Storage defaults to filesystem, assets go to ./assets/
});
```

## Configuring Storage

Switch backends or customize settings via `storageOptions`:

```typescript
const copilotz = await createCopilotz({
  storageOptions: {
    provider: "s3",
    bucket: "my-assets-bucket",
    region: "us-east-1",
  },
  // ...
});
```

### Filesystem options

| Option | Default | Description |
|--------|---------|-------------|
| `provider` | `"fs"` | Use `"fs"` for local storage |
| `rootDir` | `"./assets"` | Root directory for stored files |

### S3 options

| Option | Default | Description |
|--------|---------|-------------|
| `provider` | — | Use `"s3"` for S3-compatible storage |
| `bucket` | — | Bucket name |
| `region` | `"us-east-1"` | AWS region |
| `endpoint` | AWS default | Custom endpoint (for MinIO, R2, etc.) |
| `accessKeyId` | From env | AWS access key |
| `secretAccessKey` | From env | AWS secret key |

## How Assets Flow

1. A tool returns binary data (e.g. a generated chart, fetched file)
2. Copilotz detects the asset in the tool output
3. The storage backend saves it and returns an `assetId`
4. The tool output is rewritten with an `asset://` reference
5. On the next LLM call, `asset://` refs are resolved to data URLs for vision models
6. An `ASSET_CREATED` event is emitted to the stream

## The AssetStore Interface

The underlying storage interface used by the asset system:

```typescript
interface AssetStore {
  save(bytes: Uint8Array, mime: string): Promise<{ assetId: string; info?: AssetInfo }>;
  get(assetId: string): Promise<{ bytes: Uint8Array; mime: string }>;
  urlFor(assetId: string, opts?: { inline?: boolean }): Promise<string>;
  info?(assetId: string): Promise<AssetInfo | undefined>;
}
```

## Writing a Custom Storage Backend

A storage connector implements the low-level read/write operations. Here's a minimal example:

```typescript
export interface MyConnector {
  writeFile(path: string, data: Uint8Array): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  exists(path: string): Promise<boolean>;
  remove(path: string): Promise<void>;
}

export function createMyConnector(config: MyConfig): MyConnector {
  return {
    async writeFile(path, data) {
      // Write bytes to your backend
    },
    async readFile(path) {
      // Read bytes from your backend
      return new Uint8Array();
    },
    async exists(path) {
      // Check if the file exists
      return false;
    },
    async remove(path) {
      // Delete the file
    },
  };
}
```

### Registering via resources directory

Create `resources/storage/my-backend/adapter.ts` with your connector implementation, then declare it in `resources/manifest.ts`:

```typescript
export default {
  provides: {
    storage: ["my-backend"],
  },
};
```

## S3-Compatible Services

The built-in `s3` backend works with any S3-compatible service. Set a custom `endpoint`:

```typescript
storageOptions: {
  provider: "s3",
  bucket: "my-bucket",
  endpoint: "https://my-minio.example.com",
  // For Cloudflare R2:
  // endpoint: "https://<account-id>.r2.cloudflarestorage.com",
}
```

## Next Steps

- [Resources](./resources.md) — Resource system overview
- [Assets](./assets.md) — How the asset pipeline works
- [Configuration](./configuration.md) — Full configuration reference
