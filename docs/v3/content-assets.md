---
title: Copilotz v3 Content and Asset Model
description: A unified durable-content contract for text, structured values, tools, files, and realtime outcomes.
section: Internal Design
status: implementation
---

# Copilotz v3 Content and Asset Model

## Decision

Copilotz v3 treats every durable content body as an asset and stores stable
references from domain records and semantic events.

“Asset” no longer means only an uploaded file. It means an immutable,
addressable body with a media type. Text, JSON, tool arguments/results, files,
images, finalized audio, transcripts, and future modalities all use the same
primitive. The physical body can live in the database or object storage without
changing the reference.

This does **not** make the entire message or event envelope an opaque asset.
Fields required to route, authorize, order, recover, query, and settle work stay
inline. Only content bodies and optional large diagnostics are referenced.

```text
message / tool execution / event
  ├─ inline: identity, routing, status, causation, visibility, timestamps
  └─ content refs (ordered, typed, immutable)
       └─ asset metadata
            └─ body: database | object store
```

Raw token, audio, and future video frames are not assets as they travel. They
remain ephemeral Web Stream chunks. A completed recording or transcript becomes
an asset only when retention policy elects to persist it.

## Implementation Status

The Gate 2 content seam is implemented in `runtime/content/` and exported from
the root package and the `./content` subpath. It provides factory-created,
runtime-neutral contracts for immediate publication, transaction-free boundary
preparation, authorization-aware batch resolution, SHA-256 integrity checks, and
Web Stream reads. A tenant-scoped memory repository remains available for
isolated tests and explicitly non-durable embedded use.

The graph-native repository stores metadata and ownership in asset nodes while
database, memory, filesystem-capability, S3-compatible, or injected stores own
the immutable body. Database storage is the default with an 8 MiB per-asset
limit. `createContentPreparer()` produces refs plus uncommitted immutable
bodies; a typed aggregate then commits those bodies, its owner, `has_asset`
edges, one compact semantic event, and all matched deliveries in one Ominipg
transaction. Standalone publication emits `asset.created`. Message creation now
uses this path, validates existing refs transactionally, and detects content
conflicts on an idempotent replay. Events and message nodes never duplicate body
data.

Tool executions and logical/provider LLM attempts now use the same repository
for role-labelled arguments, output, projections, errors, model input, answer,
reasoning, tool calls, and restricted traces. Owner links are synchronized when
mutable workflow projections replace content, and promoting a tool output or LLM
answer into a public message reuses its immutable body.

S3-compatible writes use deterministic provenance paths and signed conditional
creation. A successful immutable PUT acknowledges the sent payload and metadata;
existing or racing keys are verified with HEAD before reuse. Persisted locations
dispatch mixed reads during migration. Generic tool-result extraction removes
nested encoded bodies before live output, persistence, and model reuse. The
isolated content-v2 migration repairs tool-authored legacy messages and performs
resumable database-to-object relocation.

## Goals

1. Give text, structured tool data, files, and finalized media one durable
   representation.
2. Keep domain/event rows small and avoid duplicating the same body in messages,
   tool executions, events, and provider traces.
3. Allow storage placement to change by size, tenant, runtime, or policy without
   changing application references.
4. Preserve ordered multimodal content and support consumer-specific projection
   for LLMs, tools, UI, channels, and search.
5. Support in-process and remote Oxian execution using serializable references.
6. Make streaming foundational without persisting every frame.
7. Preserve current string/parts/data-URL/`asset://` inputs through edge
   adapters during migration.

## Non-Goals

- Storing routing or delivery state in asset bodies.
- Treating ephemeral deltas as durable domain events.
- Requiring object storage for small text and JSON.
- Making every consumer download every body.
- Providing cross-tenant content deduplication.
- Choosing production codecs, VAD, video processing, or a specific realtime LLM
  provider in this refactor.
- Making content mutable after publication.

## Vocabulary

### Envelope

A routed semantic event. It contains searchable orchestration fields inline:
type, subject, namespace/schema, thread, participant, visibility, causation,
correlation, deduplication, and compact state changes. It can carry ordered
content references but never requires body resolution to determine recipients or
durable deliveries.

### Asset

The logical metadata record for one immutable body. An asset has a stable ID,
tenant scope, media type, integrity digest, size, lifecycle state, and storage
locator. An asset can contain text, JSON, binary media, a document, or a
provider-specific trace.

### Content reference

A domain-safe pointer from a message, tool execution, event, document, or other
record to an asset. It adds the body’s role and presentation metadata without
copying the body.

### Content sequence

An ordered list of content references. Ordering belongs to the owning domain
record, not to the asset, so the same immutable asset can be reused in different
messages or projections.

### Projection

A consumer-specific resolved view. For example, one content sequence may become
OpenAI input parts, an Anthropic message, a UI attachment, plain search text, or
a channel upload. Projections are derived and are not a second canonical body.

### Stream

An ephemeral, backpressured sequence of bytes or semantic deltas. A stream has
runtime identity and causation metadata, but its frames do not have database
positions. It can optionally finalize into one or more assets.

## Logical Types

These types describe the contract. Names may change during implementation, but
their separation of concerns must remain.

```ts
type AssetId = string;

type AssetState =
  | "staging"
  | "ready"
  | "failed"
  | "abandoned"
  | "deleted";

type AssetBodyLocation =
  | {
    kind: "database";
    encoding: "utf8" | "json" | "base64";
  }
  | {
    kind: "object";
    backendId: string;
    key: string;
    etag?: string;
  };

interface AssetRecord {
  id: AssetId;
  namespace: string;
  mediaType: string;
  byteLength: number;
  digest: `sha256:${string}`;
  state: AssetState;
  location: AssetBodyLocation;
  createdAt: string;
  readyAt?: string;
  metadata?: Record<string, unknown>;
}

type ContentKind =
  | "text"
  | "json"
  | "image"
  | "audio"
  | "video"
  | "file";

type ContentRole =
  | "body"
  | "attachment"
  | "reasoning"
  | "tool.arguments"
  | "tool.output"
  | "tool.projected_output"
  | "tool.error_detail"
  | "transcript"
  | "recording"
  | "document.source"
  | "provider.trace";

interface ContentRef {
  assetId: AssetId;
  kind: ContentKind;
  role: ContentRole | string;
  mediaType: string;
  name?: string;
  alt?: string;
  language?: string;
  disposition?: "inline" | "attachment";
  metadata?: Record<string, unknown>;
}

type ContentSequence = readonly ContentRef[];
```

`ContentRef` intentionally does not expose a storage key or signed URL. Those
are resolver concerns and may change without rewriting domain records.

### IDs and integrity

- Asset identity is a ULID, not a content hash.
- Every ready asset records a SHA-256 digest for integrity and idempotent upload
  finalization.
- Automatic cross-tenant deduplication is prohibited.
- Within-tenant deduplication is off by default and can be added later as an
  explicit storage policy. References and authorization never rely on dedupe.

### Immutability

Once an asset reaches `ready`, its body, media type, digest, and byte length are
immutable. Correcting content creates a new asset and updates the owning domain
record through a normal mutation. Presentation metadata on a `ContentRef` may
differ per owner without mutating the asset.

## What Remains Inline

The following are control or query data, not content bodies:

- event ID/type/version/position and subject;
- namespace, schema, thread, participant, and resource IDs;
- visibility, routing, target, and channel information;
- causation, correlation, deduplication, and idempotency IDs;
- delivery status, attempts, lease, priority, and error classification;
- message sender/type/order and content-reference order;
- tool name, call ID, status, timing, visibility, and retry metadata;
- LLM provider/model/status, token counts, cost, stop reason, and attempt links;
- stream ID, media type, participant, direction, state, and interruption reason;
- compact domain deltas needed to understand a semantic event without resolving
  a body.

An error’s stable code and safe summary stay inline. A large stack trace or raw
provider response can be an access-controlled diagnostic asset.

## Canonical Domain Shapes

### Messages

The canonical message record stores an ordered content sequence instead of a
single text body:

```ts
interface MessageContentFields {
  content: ContentSequence;
  preview?: string;
  searchText?: string;
}
```

`preview` and `searchText` are optional derived projections. They are not
canonical and can be regenerated. They allow thread lists and text search
without resolving every asset.

A plain message creates one `text/plain; charset=utf-8` asset. A multimodal
message creates one content reference per ordered part. References can be shared
when the exact same body is intentionally reused; a tool result promoted into a
message should normally reuse its output asset rather than copy it.

Reasoning is a content reference with role `reasoning` and existing visibility
policy. Making it an asset does not make it public.

### Tool executions

Tool control state stays inline. Bodies become references:

```ts
interface ToolExecutionContentFields {
  arguments: ContentRef; // application/json
  output?: ContentRef;
  projectedOutput?: ContentRef;
  errorDetail?: ContentRef;
  assets?: ContentSequence;
}
```

The provider tool-call ID, tool resource ID, agent ID, status, timing,
`historyVisibility`, idempotency key, and safe error summary remain inline. The
provider label is not the durable execution identity and may recur in later
attempts. The tool-execution node/event ID remains canonical; lookup by provider
tool-call ID returns the latest matching execution in the thread.

The runtime resolves `arguments` before invoking a tool. A local or remote
worker receives either the already-resolved value under an explicit size limit
or the content reference plus a scoped resolver capability. It never receives a
serialized closure.

Tool output is encoded as `application/json` when it is JSON-compatible,
`text/plain` for text, or its declared media type for binary/media output. The
projected output used in model history is a separate reference only when its
body differs. Otherwise it reuses the output reference.

### LLM attempts

Attempt identity, provider/model, usage, cost, timing, status, and stop reason
stay inline. Canonical inputs reference existing message/tool content rather
than copying a rendered prompt. Final answer and reasoning assets can be reused
by the message created from that attempt.

Raw provider requests/responses are optional diagnostic assets with restricted
visibility and retention. They are not required for ordinary recovery.

### Documents, memory, and custom collections

Document source bodies use `document.source` references. Parsed text, chunks,
embeddings, and searchable metadata remain queryable projections where needed.
Long-term memory can use text content references while retaining ownership,
range/checkpoint, confidence, and access metadata inline.

Custom collections may declare content-reference fields. They are not forced to
assetize every application string; the universal rule applies to Copilotz
canonical content bodies and explicitly declared large-content fields, not to
ordinary product attributes such as a card title or email address.

## Semantic Events

A semantic event references content but does not duplicate it:

```ts
interface DurableEventShape {
  id: string;
  position: bigint;
  version: number;
  type: string;
  namespace: string;
  threadId?: string;
  subject: { type: string; id: string };
  causationId?: string;
  correlationId: string;
  deduplicationId?: string;
  visibility?: Record<string, unknown>;
  routing?: Record<string, unknown>;
  delta?: Record<string, unknown>;
  content?: ContentSequence;
  createdAt: string;
}
```

The `delta` can contain compact values required to interpret the mutation, but
not a second copy of message text, tool output, file bytes, or a full
before/after snapshot. Recipients and delivery rows are resolved without loading
assets.

Creating subordinate assets as part of a message/tool aggregate does not have to
emit an `asset.created` event for each leaf. The aggregate semantic event can
reference them. A standalone uploaded/published asset emits `asset.created`.
This avoids event and delivery growth proportional to multipart body count.

## Physical Storage Policy

The logical asset record is a native graph collection node. The four-table v3
database remains sufficient: small bodies can live inside the asset node data;
large bodies use a storage locator. No separate content table is required by the
model.

Initial policy:

- Every durable body is stored in the selected backend. Database storage is the
  default and accepts up to 8 MiB of decoded content per asset.
- Explicit S3-compatible storage places text, JSON, and binary bodies in the
  configured object backend.
- A runtime without durable object storage rejects oversized durable content or
  uses an explicitly configured remote asset backend; it never silently drops
  the body.
- The in-memory backend is valid only when every producer and consumer is in the
  same process and durability is not requested.
- `passthrough` remains an edge compatibility mode, not a valid backend for
  durable referenced content.

The event-native history endpoint resolves a page as one compound document, so
clients do not issue one HTTP request per content part. Canonical messages stay
in `data`; `included.content` contains each requested immutable body alongside
its original ref and asset record. `included.llmAttempts` and
`included.toolExecutions` preserve workflow identity for reasoning, tool calls,
progressive tool state, and final projected output.

## Write and Transaction Protocol

### Small database-backed content

One Ominipg transaction writes:

1. the ready asset node and body;
2. the owning message/tool/domain node and content reference;
3. graph relationships;
4. the immutable semantic event; and
5. required durable delivery rows.

All become visible together.

### Large object-backed content

Object stores cannot participate in the PostgreSQL transaction, so writes use a
staged protocol:

1. stream the body to a tenant-scoped staging key while computing digest/size;
2. finalize to an immutable key or verify the completed multipart object;
3. transactionally create the ready asset node, owner, event, and deliveries;
4. garbage-collect finalized-but-unreferenced objects after a safety window.

The owner is never committed with a reference to an unreadable object. A crash
before step 3 leaves an orphan eligible for cleanup. A retry uses the operation
idempotency key and digest to avoid duplicate publication.

### Idempotency

Source event and delivery IDs flow into mutation idempotency keys. Creating the
same logical body/owner link on retry returns the existing asset/reference.
External tools and asset backends receive the idempotency key where supported.

## Read and Projection Protocol

Consumers ask for the representation they need:

```ts
interface ContentResolver {
  get(
    ref: ContentRef,
    options?: ResolveContentOptions,
  ): Promise<ResolvedContent>;
  getMany(
    refs: readonly ContentRef[],
    options?: ResolveContentOptions,
  ): Promise<readonly ResolvedContent[]>;
  open(
    ref: ContentRef,
    options?: ResolveContentOptions,
  ): Promise<ReadableStream<Uint8Array>>;
}
```

Projection rules:

- LLM adapters receive provider-specific ordered parts and enforce model
  capabilities/token budgets.
- Tools receive parsed JSON/text or a byte stream according to their declared
  input contract.
- UI/server adapters receive text previews, attachment descriptors, and signed
  or data URLs only when authorized.
- Channels decide whether to upload bytes, send a URL, or render text.
- Search/indexing uses derived searchable text and never scans object storage at
  query time.
- Admin defaults to metadata/previews; diagnostic bodies require explicit
  authorization.

Resolution errors are typed as unavailable, unauthorized, corrupted, deleted, or
unsupported media. A missing optional attachment need not erase the rest of the
message.

## Unified Input API

Existing ergonomic inputs remain accepted at boundaries:

```ts
await copilotz.send({
  content: "Hello",
  sender: user,
});

await copilotz.send({
  content: [
    { type: "text", text: "What is in this image?" },
    { type: "image", asset: imageRef, alt: "A receipt" },
  ],
  sender: user,
});
```

The input normalizer accepts:

- strings;
- current text/image/audio/file/JSON parts;
- `asset://` references and canonical `ContentRef` values;
- URLs or data URLs only under an explicit fetch/ingress policy;
- byte arrays/blobs/files in runtimes that provide them; and
- stream-bearing input through plugin-owned ingress commands.

It writes or validates assets and returns a canonical `ContentSequence` before
the domain mutation commits. Internal code does not continue carrying all legacy
unions after normalization.

## Realtime Streams

### Ingress

`copilotz.send()` is the application ingress method:

```ts
const input = await copilotz.send({
  type: "audio.input",
  mediaType: "audio/pcm;rate=24000",
  payload: microphoneStream,
});

// Acceptance is immediate; completion tracks this stream's causal scope.
await input.done;
```

Calling `send()` with a stream returns `{ streamId, done, cancel }` after the
stream is accepted. It does not wait for EOF. The runtime passes byte chunks
through Web Streams/Oxian with backpressure and cancellation.

No chunk creates an asset, semantic event, delivery, graph node, or database
position. Durable events are limited to meaningful boundaries such as stream
accepted/opened, interruption, final transcript, final participant message,
tool/ask activity, failure, and stream closed. Open/close events contain stream
metadata, not frames.

### Output

`copilotz.observe()` yields semantic events or participant-labelled streams:

```ts
type AttachmentOutput =
  | CopilotzEvent
  | {
    type: "stream.output";
    streamId: string;
    participant: { id: string; type: "agent" | "user" | "tool" };
    mediaType: string;
    causationId?: string;
    correlationId: string;
    payload: ReadableStream<Uint8Array>;
  };
```

Multiple agents can emit concurrent, independently labelled streams. Copilotz
does not impose a single-speaker lock at the event model. A channel or UI may
apply a mixing, interruption, priority, or single-speaker policy as a separate
resource.

### Stream finalization and retention

While a recording is retained, a factory-created streaming asset writer owns a
`staging` asset. On normal EOF it computes digest/size, finalizes storage, and
publishes a `ready` asset in the same aggregate mutation as its final semantic
result. Cancellation marks staging work abandoned; maintenance removes it.

Default retention policy for the first v3 release:

- raw realtime input audio: not retained;
- raw realtime output audio: not retained unless the channel/application opts
  into replay;
- final transcript: retained as content when one is produced;
- final participant message: retained normally and may reference the transcript
  asset rather than duplicate it;
- discrete uploaded files/audio: retained according to ordinary thread/asset
  policy.

This default is privacy- and storage-conscious while keeping replay available as
an explicit policy.

## Security and Tenancy

1. Every asset belongs to one namespace/schema security boundary.
2. A content reference is resolved under the requesting domain context; knowing
   an asset ID is not authorization.
3. Storage keys are tenant-scoped and non-guessable. Signed URLs are short-lived
   projections, never canonical fields.
4. Cross-tenant references and namespace-mismatched `asset://` values fail
   closed.
5. External URL ingestion uses allowlists, size/time limits, redirect limits,
   MIME verification, and SSRF protections.
6. Diagnostic assets can carry stricter visibility/retention than their parent
   event.
7. Digest comparison does not expose or merge content across tenants.
8. Encryption-at-rest can be selected per backend/tenant without changing the
   content reference contract.

## Retention, Deletion, and Compaction

- Domain references are liveness roots for assets.
- Event/delivery compaction does not delete assets still referenced by messages,
  tools, documents, memories, or custom records.
- Deleting a domain record removes its reference; an asset is collectible only
  when no live root or retention hold remains.
- Staging/abandoned assets and unreferenced object-store uploads are collected
  after a safety window.
- Dead-lettered work can pin the assets required for retry.
- Legal/tenant retention policies can pin or redact independently of the default
  seven-day event/delivery compaction.
- Hard deletion records a tombstone/state transition before physical object
  removal so stale references fail deterministically.

## Factory-First Module Boundaries

The implementation should converge on small factories, not service classes:

```ts
const assets = createAssetRepository({ session, bodyStore, policy });
const normalizeContent = createContentNormalizer({ assets, fetchPolicy });
const resolveContent = createContentResolver({ assets, authorization });
const projectContent = createContentProjector({ resolveContent, providers });
const createStreamWriter = createStreamingAssetWriterFactory({ assets });
```

Suggested plain-object contracts:

- asset repository: stage, publish, get metadata, open body, link/unlink, mark
  failed/abandoned;
- body store: put/open/delete/stat for database and object backends;
- normalizer: convert edge inputs to canonical references;
- resolver: authorize and batch-resolve references;
- projector: build provider/UI/channel/tool/search views;
- stream writer: accept chunks, report pressure, finalize, or abandon;
- retention coordinator: find collectible assets and perform bounded cleanup.

Factories receive capabilities explicitly. Filesystem, environment, server,
crypto-provider, and remote-object concerns are runtime adapters, not global
imports in core.

## Oxian Execution Contract

- Discrete workloads carry event ID, delivery ID, logical plugin/resource ID,
  and tenant context.
- Workers resolve records/content using injected Ominipg and asset capabilities.
- Stream workloads carry stream metadata plus transferable/supported Web
  Streams, never database frame records.
- The default private host can use an in-memory body backend only for explicitly
  non-durable operation.
- A remote/shared execution topology requires a storage backend visible to both
  producer and worker, or a scoped content-transfer workload.
- Copilotz owns and closes only the private host/database it created. An
  injected dispatcher, target, database, or storage backend remains app-owned.

## Migration

### Ingress and egress

The final boundary:

- accepts source content strings and structured parts at declared semantic
  boundaries;
- uses canonical Asset references after durable materialization;
- exposes event-native content and history without a second legacy DTO or wire
  projection;
- applies authorization and size limits in the application-owned HTTP boundary.

Canonical internal records never store two content representations.

### Existing records

The isolated v1 upgrade creates assets for existing bodies and rewrites domain
records to references inside each tenant's upgrade transaction:

1. text/reasoning fields become text assets;
2. current attachment metadata and asset nodes are normalized and linked;
3. tool args/output/projected output/error become typed content assets;
4. document sources and memory snapshots are migrated according to their
   collection;
5. duplicate body copies within one aggregate can reuse a single newly created
   asset after integrity checks;
6. IDs and message/tool/domain relationships remain stable;
7. derived chunk/search text remains inline as an intentional searchable
   projection;
8. migration is idempotent and applies independently to every tenant schema;
9. non-canonical legacy asset records require `resolveLegacyAsset`, supplied by
   the maintenance adapter that knows how to read the old filesystem or object
   store; and
10. legacy `metadata.attachments` entries become ordered `attachment` content
    refs while their compatibility metadata remains available at the boundary.

Old body fields are removed only after reference resolution and digest/size
verification. Unexpected resolver or encoding failures roll the tenant back to
the untouched v1 tables. If an adapter confirms that a body was already missing,
it may return an explicit `failed` or `abandoned` result; the upgrade preserves
that unreadable asset and its refs without manufacturing content. Tenant schemas
are upgraded independently so an operator can validate and back up each tenant
before continuing.

## Acceptance Tests

The following tests complement A30–A35 in the parity ledger.

### Durable content

- Ordered mixed content round-trips without losing media type, role, name, alt,
  or language.
- The same tool output promoted to a message reuses one body.
- Small database-backed and large object-backed assets have identical resolver
  behavior.
- A failed object upload cannot publish an owner/event/delivery; a crash after
  upload creates only a collectible orphan.
- Concurrent idempotent retries publish one logical owner/reference.
- Digest mismatch and truncated bodies fail as corrupted.
- Batch history resolution avoids per-part round trips.
- Search uses projections and respects namespace/visibility.
- Retention does not collect assets pinned by live records or dead letters.
- Cross-tenant refs, signed URLs, and diagnostic visibility fail closed.

### Realtime — A36 to A42

| ID  | Test                           | Required assertion                                                                                 |
| --- | ------------------------------ | -------------------------------------------------------------------------------------------------- |
| A36 | One-call stream ingress        | `send({ payload: ReadableStream })` returns after acceptance with stream ID, `done`, and `cancel`. |
| A37 | Frame non-persistence          | Database growth is independent of frame count/size except an explicitly retained final asset.      |
| A38 | Backpressure/cancellation      | Slow consumers pressure producers; cancellation closes transport and abandons staging content.     |
| A39 | Semantic finalization          | Final transcript/message and optional recording publish atomically with events/deliveries.         |
| A40 | Concurrent participant output  | Two agents can emit separate labelled streams without frame mixing or forced serialization.        |
| A41 | Realtime tools and public asks | Tool calls and agent-to-agent asks occur as semantic events while audio streams remain open.       |
| A42 | Transport parity               | A36–A41 behave through private in-process and injected/remote Oxian transports.                    |

### Background work — A43 to A44

| ID  | Test                       | Required assertion                                                                                               |
| --- | -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| A43 | Scheduled content lifetime | A scheduled/background delivery pins referenced content through execution/retry and releases it after retention. |
| A44 | Short-lived maintenance    | Opportunistic maintenance safely handles abandoned staging assets and due deliveries without a resident timer.   |

## Proposed Defaults for Review

Unless review changes them, implementation and tests should use these defaults:

1. Durable Copilotz content bodies use stable asset references.
2. Routing/query/settlement metadata stays inline.
3. Assets are immutable after ready; ULID identity and SHA-256 integrity are
   separate.
4. Storage placement is transparent to the reference.
5. No cross-tenant deduplication; within-tenant dedupe is off initially.
6. Raw frames are ephemeral; final semantic outcomes can be durable.
7. Raw realtime input/output recording is opt-in; final transcripts/messages are
   durable by default.
8. Compatibility is an edge projection, not dual canonical storage.
9. Runtime construction is factory-first and capability-injected.

## Follow-up Decisions

1. Decide whether v3 REST exposes content sequences directly at `/v2`, through
   content negotiation, or both.
2. Define which custom collection schema helper marks a field as
   asset-backed/large content.
3. Choose searchable-text projection and indexing policy per content/media type.
4. Define default retention durations for opt-in recordings and diagnostic
   provider traces.
5. Decide whether tenant-local dedupe is worthwhile after measuring body reuse
   and privacy/GC complexity.
6. Define encryption key ownership/rotation for database and object bodies.
7. Decide whether standalone asset publication emits one general `asset.created`
   event or media-specific semantic subtypes.
