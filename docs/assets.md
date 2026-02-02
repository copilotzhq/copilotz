# Assets

Assets are how Copilotz handles files, images, and media. The asset system provides automatic extraction from tool outputs, persistent storage, and seamless resolution for LLM vision capabilities.

## How Assets Work

When a tool returns binary data (like an image), Copilotz:

1. **Detects** the asset in the tool output
2. **Stores** it in the configured backend
3. **Replaces** the raw data with an `asset://` reference
4. **Emits** an `ASSET_CREATED` event
5. **Resolves** the reference to a data URL when sending to the LLM

This means your tools can return raw base64 data, and Copilotz handles the rest.

```
Tool returns { mimeType: "image/png", dataBase64: "iVBORw0..." }
                          │
                          ▼
            Asset detected and stored
                          │
                          ▼
         Replaced with { assetRef: "asset://abc123", mimeType: "image/png" }
                          │
                          ▼
              ASSET_CREATED event emitted
                          │
                          ▼
        When sent to LLM, resolved to data:image/png;base64,...
```

## Configuration

### Filesystem Backend

```typescript
const copilotz = await createCopilotz({
  agents: [...],
  assets: {
    config: {
      backend: "fs",
      fs: {
        rootDir: "./data/assets",
        baseUrl: "https://cdn.example.com/assets",  // Optional public URL
      },
      inlineThresholdBytes: 100_000,  // Max size for inline resolution
      resolveInLLM: true,              // Resolve asset refs before LLM calls
    },
  },
});
```

### S3 Backend

```typescript
assets: {
  config: {
    backend: "s3",
    s3: {
      bucket: "my-assets-bucket",
      endpoint: "https://s3.amazonaws.com",  // Or MinIO, R2, etc.
      region: "us-east-1",
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  },
}
```

You can also provide a custom connector (optional):

```typescript
import { createS3Connector } from "@copilotz/copilotz/connectors/storage/s3";

const connector = createS3Connector({
  endpoint: "https://s3.amazonaws.com",
  region: "us-east-1",
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
});

assets: {
  config: {
    backend: "s3",
    s3: { bucket: "my-assets-bucket", connector },
  },
}
```

### Memory Backend (Testing)

```typescript
import { createMemoryAssetStore } from "@copilotz/copilotz";

const memoryStore = createMemoryAssetStore();

const copilotz = await createCopilotz({
  agents: [...],
  assets: { store: memoryStore },
});
```

### Passthrough Backend

For external storage integration — emits events but doesn't persist:

```typescript
assets: {
  config: {
    backend: "passthrough",
  },
}
```

Assets are retrievable once after creation, then deleted. Use this when you want to handle storage yourself via the `ASSET_CREATED` event.

---

### Namespacing (Tenant Isolation)

Enable namespacing to scope assets by `ChatContext.namespace` (which comes from `CopilotzConfig.namespace` or `RunOptions.namespace`):

```typescript
const copilotz = await createCopilotz({
  namespace: "tenant-123",
  agents: [...],
  assets: {
    config: {
      backend: "s3",
      namespacing: { mode: "context", includeInRef: true },
      s3: {
        bucket: "my-assets-bucket",
        endpoint: "https://s3.amazonaws.com",
        region: "us-east-1",
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    },
  },
});
```

With `includeInRef: true`, refs look like `asset://tenant-123/<id>`.

---

## Asset References

Assets are referenced using `asset://` URIs:

```
asset://550e8400-e29b-41d4-a716-446655440000
```

When namespacing is enabled, refs include the namespace:

```
asset://tenant-123/550e8400-e29b-41d4-a716-446655440000
```

Namespaces are URL-encoded inside the ref; use `parseAssetRef()` to decode.

Helper functions:

```typescript
import { isAssetRef, extractAssetId, parseAssetRef } from "@copilotz/copilotz";

isAssetRef("asset://abc123");     // true
isAssetRef("https://example.com"); // false

extractAssetId("asset://abc123");  // "abc123"
extractAssetId("asset://tenant-123/abc123");  // "abc123"

parseAssetRef("asset://tenant-123/abc123");
// { id: "abc123", namespace: "tenant-123" }
```

---

## The copilotz.assets API

### getBase64()

Get an asset as base64-encoded data:

```typescript
const { base64, mime } = await copilotz.assets.getBase64("asset://abc123");
// Or just the ID:
const { base64, mime } = await copilotz.assets.getBase64("abc123");
// Or with explicit namespace:
const { base64, mime } = await copilotz.assets.getBase64("asset://abc123", { namespace: "tenant-123" });

// base64: "iVBORw0KGgoAAAANSUhEUg..."
// mime: "image/png"
```

### getDataUrl()

Get an asset as a data URL (ready for HTML or LLM):

```typescript
const dataUrl = await copilotz.assets.getDataUrl("asset://abc123");
const dataUrl = await copilotz.assets.getDataUrl("asset://abc123", { namespace: "tenant-123" });
// "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg..."
```

---

## Automatic Asset Extraction

Copilotz automatically extracts assets from tool outputs. Your tools can return:

### Format 1: Base64 with MIME Type

```typescript
// Tool returns:
{
  mimeType: "image/png",
  dataBase64: "iVBORw0KGgoAAAANSUhEUg..."
}

// Automatically converted to:
{
  assetRef: "asset://abc123",
  mimeType: "image/png",
  kind: "image"
}
```

### Format 2: Data URL

```typescript
// Tool returns:
{
  dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg..."
}

// Automatically converted to:
{
  assetRef: "asset://abc123",
  mimeType: "image/png",
  kind: "image"
}
```

### Format 3: Direct Data URL String

```typescript
// Tool returns:
"data:image/png;base64,iVBORw0KGgoAAAANSUhEUg..."

// Automatically converted to:
{
  assetRef: "asset://abc123",
  mimeType: "image/png",
  kind: "image"
}
```

### Nested Objects

Asset extraction works recursively:

```typescript
// Tool returns:
{
  result: "success",
  images: [
    { mimeType: "image/png", dataBase64: "..." },
    { mimeType: "image/jpeg", dataBase64: "..." }
  ]
}

// Automatically converted to:
{
  result: "success",
  images: [
    { assetRef: "asset://abc123", mimeType: "image/png", kind: "image" },
    { assetRef: "asset://def456", mimeType: "image/jpeg", kind: "image" }
  ]
}
```

---

## Asset Events

### ASSET_CREATED

Emitted whenever an asset is extracted and stored:

```typescript
{
  type: "ASSET_CREATED",
  payload: {
    assetId: "abc123",              // The UUID
    ref: "asset://abc123",          // Full reference
    mime: "image/png",              // MIME type
    by: "tool",                     // "tool", "agent", "user", or "system"
    tool: "generate_chart",         // Tool name (if from tool)
    toolCallId: "call_xyz",         // Tool call ID (if from tool)
    base64: "iVBORw0KGgo...",       // Full base64 data
    dataUrl: "data:image/png;...",  // Full data URL
  }
}
```

Listen for asset events:

```typescript
const copilotz = await createCopilotz({
  agents: [...],
  callbacks: {
    onEvent: async (event) => {
      if (event.type === "ASSET_CREATED") {
        console.log("New asset:", event.payload.ref);
        // Upload to external CDN, save to database, etc.
      }
    },
  },
});
```

This is especially useful with the passthrough backend — you handle storage yourself:

```typescript
callbacks: {
  onEvent: async (event) => {
    if (event.type === "ASSET_CREATED") {
      // Upload to your own storage
      await myStorage.upload(
        event.payload.assetId,
        event.payload.base64,
        event.payload.mime
      );
    }
  },
}
```

---

## Assets in Custom Processors

Custom event processors receive asset access via `deps.context`:

```typescript
const processor = {
  eventType: "NEW_MESSAGE",
  process: async (event, deps) => {
    const { context } = deps;
    
    // Direct store access
    const store = context.assetStore;
    if (store) {
      // Save an asset
      const { assetId } = await store.save(bytes, "image/png");
      
      // Get an asset
      const { bytes, mime } = await store.get(assetId);
      
      // Get URL for an asset
      const url = await store.urlFor(assetId, { inline: true });
    }
    
    // Convenience resolver
    if (context.resolveAsset) {
      const { bytes, mime } = await context.resolveAsset("asset://abc123");
    }
    
    // Asset configuration
    const config = context.assetConfig;
    // { backend: "fs", resolveInLLM: true, ... }
    
    return { producedEvents: [] };
  },
};
```

### AssetStore Interface

```typescript
interface AssetStore {
  // Save bytes, returns generated ID
  save(bytes: Uint8Array, mime: string): Promise<{ assetId: string; info?: AssetInfo }>;
  
  // Get bytes by ID
  get(assetId: string): Promise<{ bytes: Uint8Array; mime: string }>;
  
  // Get URL for asset (data URL or public URL depending on backend)
  urlFor(assetId: string, opts?: { inline?: boolean }): Promise<string>;
  
  // Get asset info (optional)
  info?(assetId: string): Promise<AssetInfo | undefined>;
}
```

---

## Assets in Tool Execution Context

Custom tools receive asset access via the execution context:

```typescript
const myTool = {
  id: "my_tool",
  execute: async (input, context) => {
    // Save an asset
    if (context.assetStore) {
      const imageBytes = await generateImage(input.prompt);
      const { assetId } = await context.assetStore.save(imageBytes, "image/png");
      
      return {
        message: "Image generated",
        assetRef: `asset://${assetId}`,
      };
    }
    
    // Resolve an existing asset
    if (context.resolveAsset) {
      const { bytes, mime } = await context.resolveAsset(input.assetRef);
      // Process the asset...
    }
  },
};
```

---

## LLM Resolution

When `resolveInLLM: true` (default), Copilotz resolves asset references before sending messages to the LLM:

```typescript
// Message with asset reference
{
  role: "user",
  content: [
    { type: "text", text: "What's in this image?" },
    { type: "image_url", image_url: { url: "asset://abc123" } }
  ]
}

// Resolved before LLM call
{
  role: "user",
  content: [
    { type: "text", text: "What's in this image?" },
    { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo..." } }
  ]
}
```

### Resolution Behavior

- If resolution succeeds: Asset ref replaced with data URL
- If resolution fails: Replaced with text fallback `[unresolved image: asset://...]`
- If `resolveInLLM: false`: Multimodal parts stripped, text-only sent to LLM

### Disable Resolution

If you want the LLM to use tools to fetch assets instead:

```typescript
assets: {
  config: {
    resolveInLLM: false,  // Don't auto-resolve
  },
}
```

Then enable the `fetch_asset` tool for your agent.

---

## Message Attachments

Assets are stored in message metadata as attachments:

```typescript
{
  role: "user",
  content: "Here's the document",
  metadata: {
    attachments: [
      {
        kind: "image",           // "image", "audio", or "file"
        assetRef: "asset://abc123",
        mimeType: "image/png",
      },
      {
        kind: "audio",
        assetRef: "asset://def456",
        mimeType: "audio/mp3",
        format: "mp3",
      },
      {
        kind: "file",
        assetRef: "asset://ghi789",
        mimeType: "application/pdf",
        fileName: "report.pdf",
      },
    ],
  },
}
```

When building message history, attachments are converted to multimodal parts with text markers:

```typescript
// Agent sees:
[
  { type: "text", text: "[Attached image: asset_id=\"abc123\"]" },
  { type: "image_url", image_url: { url: "asset://abc123" } }
]
```

The text marker lets agents reference the asset ID in tool calls.

---

## Native Asset Tools

### save_asset

Save data to the asset store:

```typescript
// Input
{
  mimeType: "image/png",
  dataBase64: "iVBORw0KGgo..."
}

// Or reference an existing asset (no-op, returns info)
{
  ref: "asset://abc123"
}

// Output
{
  assetRef: "asset://abc123",
  mimeType: "image/png",
  size: 15234,
  kind: "image"  // "image", "audio", "video", or "file"
}
```

### fetch_asset

Retrieve an asset:

```typescript
// Input
{
  ref: "asset://abc123",
  format: "dataUrl"  // or "base64"
}

// Or by ID
{
  id: "abc123"
}

// Output (dataUrl format)
{
  assetRef: "asset://abc123",
  dataUrl: "data:image/png;base64,iVBORw0KGgo..."
}

// Output (base64 format)
{
  assetRef: "asset://abc123",
  base64: "iVBORw0KGgo...",
  mime: "image/png"
}
```

---

## MIME Type Detection

Copilotz detects MIME types using magic bytes for 20+ formats:

| Category | Formats |
|----------|---------|
| Images | PNG, JPEG, GIF, WebP, BMP, TIFF, SVG, ICO |
| Audio | MP3, WAV, OGG, FLAC, AAC, M4A |
| Video | MP4, WebM, AVI, MOV, MKV |
| Documents | PDF |
| Archives | ZIP, GZIP, TAR |
| Data | JSON, XML |

If detection fails, falls back to the provided MIME type or `application/octet-stream`.

---

## Complete Flow Example

Here's the full lifecycle of an asset:

```typescript
// 1. Tool generates an image
const generateChart = {
  id: "generate_chart",
  execute: async ({ data }) => {
    const imageBytes = await createChart(data);
    return {
      mimeType: "image/png",
      dataBase64: bytesToBase64(imageBytes),
    };
  },
};

// 2. Copilotz detects and stores the asset
//    Tool output becomes: { assetRef: "asset://abc123", mimeType: "image/png", kind: "image" }

// 3. ASSET_CREATED event emitted
//    Listeners can upload to CDN, save to database, etc.

// 4. Message stored with attachment
//    metadata.attachments = [{ kind: "image", assetRef: "asset://abc123", ... }]

// 5. On next LLM call, asset resolved
//    image_url.url = "data:image/png;base64,..." for vision models

// 6. Later, you can retrieve programmatically
const dataUrl = await copilotz.assets.getDataUrl("asset://abc123");
```

---

## Configuration Reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `backend` | `"fs"` \| `"s3"` \| `"passthrough"` | `"memory"` | Storage backend |
| `fs.rootDir` | `string` | — | Filesystem root directory |
| `fs.baseUrl` | `string` | — | Public URL prefix for assets |
| `s3.bucket` | `string` | — | S3 bucket name |
| `s3.region` | `string` | — | AWS region |
| `s3.endpoint` | `string` | — | Custom S3 endpoint (MinIO, R2, etc.) |
| `s3.accessKeyId` | `string` | — | AWS access key |
| `s3.secretAccessKey` | `string` | — | AWS secret key |
| `s3.sessionToken` | `string` | — | Optional session token for temporary creds |
| `s3.connector` | `S3Connector` | — | Custom S3 connector (optional) |
| `s3.publicBaseUrl` | `string` | — | Public URL prefix for asset keys |
| `s3.keyPrefix` | `string` | — | Key prefix within the bucket |
| `namespacing.mode` | `"none"` \| `"context"` | `"none"` | Scope assets by `ChatContext.namespace` |
| `namespacing.includeInRef` | `boolean` | `false` | Include namespace in asset refs |
| `inlineThresholdBytes` | `number` | `100000` | Max bytes for inline data URLs |
| `resolveInLLM` | `boolean` | `true` | Auto-resolve asset refs for LLM |

---

## Next Steps

- [Tools](./tools.md) — Creating tools that work with assets
- [Events](./events.md) — Handling ASSET_CREATED events
- [Configuration](./configuration.md) — Full asset configuration
