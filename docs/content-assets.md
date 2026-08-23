# Canonical Content and Assets

Messages, tool inputs/results, provider attempts, knowledge documents, memory,
and finalized media use one ordered content-reference model.

```ts
type ContentRef = {
  assetId: string;
  kind: "text" | "json" | "image" | "audio" | "video" | "file";
  role: string;
  mediaType: string;
  name?: string;
  metadata?: Record<string, unknown>;
};
```

Control data needed for routing remains inline. Potentially large or binary
bodies are immutable assets, and domain records store references. This avoids
copying the same payload into messages, events, tool rows, and provider history.

## Prepare and resolve

```ts
const prepared = await context.content.prepare([
  { type: "text", text: "Explain this image" },
  {
    type: "image",
    mediaType: "image/png",
    bytes: pngBytes,
    name: "diagram.png",
  },
], { operationKey: "prepare-user-content" });

const message = await context.conversation.createMessage({
  threadId,
  sender,
  content: prepared,
}, { operationKey: "create-user-message" });

const resolved = await context.content.resolveMany(message.value.content);
```

Asset publication records digest, size, media type, and immutable bytes in the
same transaction as its owning aggregate when prepared content is committed.
Resolution rechecks namespace authorization and body integrity.

## Body storage

Database storage is the runtime-neutral default and rejects individual assets
larger than 8 MiB:

```ts
const copilotz = await createCopilotz({
  assets: {
    storage: {
      type: "database",
      config: { maxBytes: 8 * 1024 * 1024 },
    },
  },
});
```

Production services can place every body in an S3-compatible backend. Google
Cloud Storage uses its XML interoperability endpoint and HMAC credentials:

```ts
assets: {
  storage: {
    type: "s3",
    config: {
      backendId: "gcs:compass-assets",
      endpoint: "https://storage.googleapis.com",
      region: "auto",
      bucket: "compass-assets",
      accessKeyId,
      secretAccessKey,
      pathStyle: true,
      prefix: "copilotz",
    },
  },
}
```

Graph nodes retain metadata, ownership, origin, and integrity. Credentials and
physical keys never enter `ContentRef`, events, or HTTP payloads. Persisted
locations select the reader, so database and object bodies coexist during a
rolling migration.

`application.maintenance()` retries external-body deletions and removes uploads
older than 24 hours that have no corresponding graph asset. The grace period is
configurable with `assetOrphanAfterMs`; recent uploads are never treated as
orphans because they may belong to an in-flight graph transaction.

## Addressing attachments from tools

Every attachment in an LLM transcript includes a small model-visible descriptor
with its name, media type, raw asset ID, and tenant-scoped canonical reference:

```text
asset://<encoded namespace>/<encoded asset ID>
```

Native asset Actions accept either the raw ID or this canonical reference and
resolve it through `ActionContext.content`. Cross-namespace references are
rejected. The descriptor remains available even when a provider cannot consume
the file's media type directly, so an agent can pass the identifier to an
import, inspection, or transformation Action instead of asking the user to
upload the file again.

Actions that create files publish bytes through the content capability and
return a bounded projection containing the canonical reference:

```ts
const asset = await context.content.publish({
  body: bytes,
  mediaType: "text/csv",
  metadata: { name: "report.csv" },
}, { operationKey: "report:publish" });

return {
  path: "outputs/report.csv",
  size: bytes.byteLength,
  asset: {
    assetId: asset.id,
    kind: "file",
    role: "attachment",
    mediaType: "text/csv",
    name: "report.csv",
  },
};
```

The Action lifecycle persists the reference, never the body bytes. Live output,
durable JSON, and the next LLM turn therefore reuse the same canonical content.
The isolated content-v2 migration can extract historical encoded Tool results;
new Action inputs and outputs do not use `data:` URLs or base64 objects as a
binary transport.

## Streams

Opening content returns a Web `ReadableStream<Uint8Array>`. Raw realtime chunks
do not become assets or events. A provider may persist the final transcript,
message, recording, or other semantic result through the same content API.

Detailed contract: [content and asset model](v3/content-assets.md).
