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

## Addressing attachments from tools

Every attachment in an LLM transcript includes a small model-visible descriptor
with its name, media type, raw asset ID, and tenant-scoped canonical reference:

```text
asset://<encoded namespace>/<encoded asset ID>
```

Native asset tools and `WorkflowToolExecutionContext.resolveAsset()` accept
either the raw ID or this canonical reference. Cross-namespace references are
rejected. The descriptor remains available even when a provider cannot consume
the file's media type directly, so an agent can pass the identifier to an
import, inspection, or transformation tool instead of asking the user to upload
the file again.

Tools that create files return a bounded projection separately from durable
attachments:

```ts
import type { WorkflowToolResult } from "@copilotz/copilotz/workflows";

const result: WorkflowToolResult = {
  kind: "copilotz.workflow-tool.result.v1",
  output: { path: "outputs/report.csv", size: bytes.byteLength },
  attachments: [{
    type: "file",
    bytes,
    mediaType: "text/csv",
    name: "report.csv",
    role: "attachment",
  }],
};
```

Copilotz persists those attachments on the tool execution and its public tool
message. Attachment bytes never enter `tool_output.delta` or other live event
frames; clients resolve them through the canonical asset API.

## Streams

Opening content returns a Web `ReadableStream<Uint8Array>`. Raw realtime chunks
do not become assets or events. A provider may persist the final transcript,
message, recording, or other semantic result through the same content API.

Detailed contract: [content and asset model](v3/content-assets.md).
