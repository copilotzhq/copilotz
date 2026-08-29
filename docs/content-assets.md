# Content and Assets

Copilotz uses one ordered content-reference model for messages, Tool results,
knowledge, memory, and finalized media.

```ts
type ContentRef = Readonly<{
  assetId: string;
  kind: "text" | "json" | "image" | "audio" | "video" | "file";
  role: string;
  mediaType: string;
  name?: string;
  alt?: string;
  language?: string;
  disposition?: "inline" | "attachment";
  metadata?: Readonly<Record<string, unknown>>;
}>;
```

Control data stays inline. Potentially large or binary bodies become immutable
Assets, and semantic records store only refs.

For LLM input, `disposition: "attachment"` is a reference boundary: the body is
not resolved for the provider and the model receives a deterministic `asset://`
descriptor suitable for an Asset Tool. `disposition: "inline"` allows normal
materialization. A `file` with no disposition defaults to the safer attachment
behavior; text, JSON, image, audio, and video keep their existing inline
default.

## Prepare, adopt, resolve

Actions prepare content before a semantic transaction:

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

await context.transaction(async (tx) => {
  await tx.collections.message.create({
    id: messageId,
    threadId,
    senderId,
    recipientIds,
    content: prepared,
    metadata: {},
  });
});
```

The Collection kernel adopts prepared Bodies and Asset records in the same SQL
transaction as the owning record, Event Body, Event, and delivery obligations.
If planning or SQL fails, no committed semantic record points at partial
content.

Use `context.content.resolve`, `resolveMany`, or `open` to read refs. Resolution
enforces namespace isolation, canonical media metadata, and body integrity.

## Standalone Action output

An Action may publish a standalone Asset and return a JSON-safe ref:

```ts
const asset = await context.content.publish({
  body: bytes,
  mediaType: "text/csv",
  metadata: { name: "report.csv" },
}, { operationKey: "report:publish" });

return {
  assetId: asset.id,
  kind: "file",
  role: "attachment",
  mediaType: "text/csv",
  name: "report.csv",
};
```

Raw bytes never enter Action lifecycle JSON. Generated OpenAPI, MCP, and
persistent-terminal integrations stage all output Assets first and materialize
them once only after the complete result validates.

## Body storage

The runtime supports database, filesystem, memory, and S3-compatible BodyStores.
Persisted Asset location selects the reader, allowing several backends to
coexist. Credentials and physical keys never enter `ContentRef`.

Asset provenance is exactly:

```ts
type AssetOrigin = Readonly<{ type: string; id: string }>;
```

The runtime treats both values as opaque. A Ready Asset node's indexed body ID
is the durable liveness authority. Collection replay restores location, body ID,
ownership edges, and exact bytes without copying external bodies.

## Canonical references

Tool-visible references use:

```text
asset://<encoded namespace>/<encoded asset ID>
```

Decoding preserves slash-containing Asset IDs and rejects cross-namespace or
collapsing paths. New integrations return `ContentRef`; they do not use data
URLs or arbitrary base64 objects as a binary lifecycle transport.

See [progressive streams](streams.md) for live byte output.
