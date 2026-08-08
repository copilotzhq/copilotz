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
    data: pngBytes,
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

## Streams

Opening content returns a Web `ReadableStream<Uint8Array>`. Raw realtime chunks
do not become assets or events. A provider may persist the final transcript,
message, recording, or other semantic result through the same content API.

Detailed contract: [content and asset model](v3/content-assets.md).
