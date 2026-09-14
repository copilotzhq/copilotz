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

## Resolve content with a Collection read

Scoped Collections accept `content` in the existing second options argument of
`get`, `list`, and `search`:

```ts
const record = await context.collections.document.get({ id });
const resolved = await context.collections.document.get({ id }, {
  content: true,
  signal,
});
const page = await context.collections.document.list({ limit: 20 }, {
  content: {
    fields: ["body", "metadata.reasoning"],
    byteLimit: 8 * 1024 * 1024,
  },
});
```

Omitted or `false` leaves references unchanged. `true` resolves every declared
content field; an object selects declared paths through `fields` and optionally
sets `byteLimit`. Omitting `fields` selects all declared paths; an empty array
selects none. Unknown or undeclared paths reject the read, even on an empty
page. Paths use the same object-only traversal as writes and asset-reference
tracking; they do not traverse array elements.

Selected fields retain their arrays and order. Each entry keeps the original
`ContentRef` properties (`assetId`, `kind`, `role`, `mediaType`, and optional
name, disposition, or metadata) and adds `value`: a string for text, parsed JSON
for JSON, or a `Uint8Array` for images, audio, video, and files.

```ts
// A resolved entry within record.body:
{ assetId: "...", kind: "text", role: "body", mediaType: "text/plain", value: "Hello" }
```

The entry type is discriminated by `kind`, so checking for `text` narrows
`value` to a string, and checking for `image` narrows it to bytes. No full
storage Asset object or included-content envelope is returned. `get` still
returns a record or `null`, and `list`/`search` return arrays. Unselected fields
retain their original values. Stored records and shared objects are not mutated.

Resolution runs after filtering and pagination and fetches each unique Asset
body once per read. Body integrity verification and text/JSON decoding are
reused within that batch; authorization and MIME validation still apply to each
reference. Duplicate references remain duplicate entries, with independent
metadata, JSON objects, and byte arrays. For full storage Asset metadata, use
the existing explicit resolver.

Literal field selections have mapped return types that preserve unselected
fields. All-field and dynamic selections conservatively widen field-array types:
the current scoped Collection types do not encode their runtime content path
declarations. JSON content has a JSON-value type, not a guessed application
schema.

Authorization and integrity checks apply. Missing, unreadable, unauthorized, or
corrupt content rejects the entire read. An aborted signal rejects the read but
does not interrupt an already-running storage batch. The default budget is 32
MiB of unique Asset body bytes, checked against metadata before fetching bodies.
It is not a bound on total memory consumed by decoding or repeated values.

The same read implementation serves explicitly contextualized Collections,
scoped Collections in Action/Processor contexts, and the `read.get`/`read.list`
services in named queries. A named query chooses resolution on its constituent
reads; there is no automatic resolution of arbitrary query output. Relation
reads keep their existing contract, and related records are not resolved
implicitly.

## Collection predicates

`get` uses an identity; `list` and `search` accept a composable `filter` tree:

```ts
const page = await documents.list(scope, {
  filter: {
    and: [
      { field: "ownerId", eq: ownerId },
      {
        or: [
          { field: "visibility.kind", eq: "public" },
          { field: "visibility.participantIds", overlaps: viewerIds },
        ],
      },
      { not: { field: "status", eq: "deleted" } },
    ],
  },
  order: { field: "createdAt", direction: "desc" },
  limit: 20,
}, { content: true });
```

Predicates support nested `and`, `or`, and `not`; scalar `eq`, `ne`, and `in`;
case-insensitive string `eqIgnoreCase` and `inIgnoreCase`; ordered `lt`, `lte`,
`gt`, and `gte`; array `overlaps`; and boolean `exists`, `isNull`, and `isBlank`
tests. Each predicate object has exactly one operator; field predicates also
require `field`. Empty `and` is true; empty `or`, `in`, `inIgnoreCase`, and
`overlaps` are false.

Nested fields use validated dotted paths. JSON scalar equality is
type-sensitive: `10` differs from `"10"`. Ranges compare numbers with numbers
and strings with strings; other JSON types do not match. `id` and `namespace`
compare native text columns, while `createdAt` and `updatedAt` compare native
timestamp columns, preserving database precision. Compound timestamp/ID
conditions can express the same tie-break ordering as pagination.

`eqIgnoreCase` and `inIgnoreCase` accept strings only. They compare text through
the database's `lower()` function, and match only JSON strings for document
fields; missing values, nulls, numbers, and arrays do not match. They do not
trim input or interpret `%`, `_`, or backslashes as patterns. Text-column and
JSON-path comparisons use the database collation and case mapping, so they do
not promise full JavaScript Unicode case-folding equivalence. Timestamp fields
(`createdAt` and `updatedAt`) reject these text-only predicates.

Missing fields are distinct from explicit JSON null. `exists: true` includes
explicit null, while `isNull: true` and `eq: null` match only explicit null.
`isBlank: true` matches only empty or whitespace-only strings, using JavaScript
`String.trim` whitespace. It excludes missing, null, and non-string values.
Predicates are two-valued: `not` negates the match, `ne` negates `eq`, and a
false boolean test negates its true form. Consequently, `ne: null` and
`isNull: false` include missing fields; add `exists: true` if absence should be
excluded.

Existing `where`, `contains`, and `containsAny` retain their semantics and are
ANDed with `filter`. Each entry of `all` may also supply a `filter`; these
enforced predicates remain outside any caller-supplied OR/NOT expression.
Namespace and collection isolation always apply.

The complete predicate runs before cursor validation, ordering, and pagination.
A cursor excluded by the predicate is rejected. Content resolution runs only on
the selected page. Predicate values are SQL parameters, and field/operator
syntax is validated. Each tree allows at most 16 levels, 256 nodes, and 1,000
operand values; field paths are at most 256 characters. Invalid inputs and
exceeded limits raise errors instead of truncating the query.

## Explicit and bound execution context

`runtime.get(name)` and `runtime.bind(definition)` return the public Collection
implementation. Every method takes an execution context first:

```ts
const scope = { namespace: "tenant-a" };
const documents = runtime.get("document")!;
const record = await documents.get(scope, { id }, { content: true });
await documents.create(scope, input, { operationKey: "create-document" });
```

`runtime.withScope(scope).document` binds the same methods, omitting that first
argument. The scope can also supply `createMutationIdentity` when used within an
Action or Processor. Identity derivation, transaction-use checks, and read
controls are implemented once, independently of scope binding. The trusted scope
supplies the namespace; write options cannot override it.

Public `create`, `update`, and commands return records; `delete` returns
`{ id, deleted: true }`. Kernel mutation reports are internal execution
primitives. Transaction writes continue to stage mutations and return mutation
references; standalone writes must not be called inside an active transaction.

Named query implementations can request resolved content through their injected
collection reads:

```ts
async select({ input, read }) {
  return await read.list("document", {
    where: { ownerId: input.ownerId },
  }, { content: { fields: ["body"] } });
}
```

A query must apply its visibility and redaction rules before resolving content
that should not be exposed. Moving resolution into shared reads does not replace
application authorization.

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

The runtime supports database, filesystem, memory, S3-compatible, and native
Google Cloud Storage BodyStores. `createGcsBodyStoreAdapter` uses the GCS JSON
API with bearer tokens (an explicit `getAccessToken` callback, or the Google
metadata-service provider); it does not read environment credentials or use HMAC
keys. It is an immutable Ready tier, so progressive streams compose a database
staging store with `createPromotedBodyStoreAdapter`. Its conservative deployment
declaration disables Ready garbage collection until exact maintenance CAS is
available. Persisted Asset location selects the reader, allowing several
backends to coexist. Credentials and physical keys never enter `ContentRef`.

The default token provider caches and refreshes the Cloud Run metadata-service
access token. Metadata requests time out after 5 seconds; GCS requests
(including body consumption) after 30 seconds. These limits and Fetch are
injectable through the factory's second argument. Uploads use an immutable
generation precondition; reads pin the exact object generation. No public ACLs
or signed URLs are created.

```ts
import { createGcsBodyStoreAdapter } from "@copilotz/copilotz/content";

const ready = createGcsBodyStoreAdapter({
  bucket: "my-private-bucket",
  backendId: "gcs:my-private-bucket",
  // Optional outside Cloud Run: getAccessToken: async () => ...
});
```

The service account needs object create/read permissions. Keep these canonical
objects out of bucket expiration policies. Existing database assets need an
explicit `database:default` reader when switching the writer. When composing
promotion, isolate its staging maintenance to new stream bodies: sharing an
unfiltered database store can otherwise treat old Ready assets as promotion
intents. Setting a different backend ID alone does not isolate database rows.
Event records and their JSON Event Bodies remain in PostgreSQL; this adapter
does not migrate or delete them.

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

## Declared Action input content

Actions can opt into runtime-managed input content:

```ts
const consume = defineAction({
  id: "example.consume",
  content: {
    input: [
      "request.messages[].content",
      "request.messages[].reasoning",
      "request.messages[].nativeReasoning.blocks",
    ],
    byteLimit: 32 * 1024 * 1024,
  },
  async execute(input, context) {
    // Declared entries contain metadata plus value: text, JSON, or Uint8Array.
    // The handler does not load Assets.
  },
});
```

Paths name content sequences; `[]` traverses arrays. Missing optional fields are
allowed. Each entry has the usual `kind`, `role`, and `mediaType` metadata, plus
`value`. An existing `assetId` is reused after authorization and value
validation. A literal value without `assetId` is published using a
media-type/content-hash idempotency key. Engine invocation uses namespace-scoped
keys across Processor runs. Explicit `{ ...ref, resolve: false }` entries remain
descriptors and are never hydrated.

Runtime snapshots input, prepares reference-only lifecycle data, and supplies
resolved values to the handler. JSON input schemas validate the execution shape,
not the reference-only persistence representation. Completed retries return
their saved result without hydrating input. Unfinished retries restore values
from the persisted references. Binary values are copied for each entry so
handler mutations do not affect other entries or the caller.

Preparation batches Asset metadata reads. Supplied values avoid body reads
except when parsed JSON must be compared with a differently serialized original
body. Recovery loads each missing Asset once. The default 32 MiB budget includes
cached and restored bodies; declarations may override it. Content authorization
applies even when a supplied value avoids a body read.

Invocation persistence atomically retains referenced Assets through `has_asset`
edges owned by an internal `@copilotz/action-content` node. Namespace rebuild
restores these owners from invoked lifecycle records using registered Action
declarations. Owners remain for durable replay; this change introduces no
automatic receipt/owner expiration. Keep the declarations available when
rebuilding their history.

This boundary currently covers **inputs only**. Outputs retain existing Action
JSON serialization. Content declarations combined with secret input/output
schemas are rejected before execution; secret-bearing content needs protected
body storage before that combination can be enabled. Custom Action hosts must
supply content authorization, metadata, publication, and resolution services.
Existing Actions without content declarations retain their current behavior.

### Selecting entries during Collection reads

Content resolution can leave selected entries as unloaded descriptors:

```ts
await messages.list(query, {
  content: {
    fields: [
      "content",
      "metadata.llmReasoning",
      "metadata.llmNativeReasoning.blocks",
    ],
    exclude: [
      { disposition: "attachment" },
      { kind: "file", disposition: null },
    ],
  },
});
```

An exclusion clause matches all its fields; any matching clause excludes the
entry. Supported fields are `kind`, `role`, `mediaType`, and `disposition`. Null
matches a missing/null property. Excluded entries retain metadata and sequence
position with `resolve: false`; their bodies are not fetched. Other entries
contain `value`. Exclusion is a content-loading choice, not an authorization
grant.

The Collection predicate `trimEq` compares a string field after ECMAScript-style
whitespace trimming. Core uses it to preserve private history scope matching for
older records while moving selection into the database.

### Collection source writes and prepared consumers

Collection-declared fields accept source `ContentInput` values as well as
references and prepared batches. The collection planner prepares sources before
SQL, reuses content by namespace, media type and digest, and commits Asset
adoption with the owning record. Transaction retries preserve content identity.
Core message Actions only decode their JSON-safe media envelopes; collection
writes own preparation, including atomic tool-result and cursor settlement.

For transient inputs outside collections,
`resolveContentInputs(inputs, content)` accepts a scoped content service with
`resolveMany`, resolves references in one batch, and returns reference-free
`ContentValue` entries. Literal inputs are copied, not persisted. Core prepares
Context contributions through this boundary before pure rendering.

`adoptPreparedBody(target, source)` returns a target preparation backed by an
already sealed, identical source body, or `undefined` when adoption is
unsuitable. It preserves target Asset identity and requires matching namespace,
media type, byte count and digest. LLM output lane selection and stream
retention policy stay in the LLM plugin; storage matching and body adoption
belong to the runtime.

### Shared reference contracts and message projection

`contentRefSchema`, `contentSequenceSchema`, and `isContentRef` are exported by
runtime content. The schemas describe persisted references; `isContentRef`
checks reference metadata and also accepts entries carrying resolved values.
Content kinds and dispositions must match their declared runtime unions.

`ConversationMessage<Content, Metadata>` defaults to ordinary reference-based
history. `mapMessageRecord` preserves known content and metadata types,
including resolved values, unloaded descriptors, and reasoning, through one
projection. Dynamic records without those type guarantees retain the
conservative default. Tool terminal reads validate resolved JSON before
interpreting the terminal envelope, without casting the content back to
reference-only types.

### Media wire codec

`encodeContent()` converts source content to JSON-safe content. Binary entries
use `{ type, mediaType, dataBase64, ...metadata }`; text, JSON and canonical
references retain their shapes. Sequence order and metadata are preserved.
`decodeContent()` reconstructs source content without network or storage I/O.

The decoder accepts exactly one of `bytes` (in-process Uint8Array), canonical
`dataBase64`, or an explicit `dataUrl` for each media entry. Base64 without a
MIME type defaults to `application/octet-stream`. A data URL supplies its MIME
type; an explicit conflicting type is rejected. Encoders always emit
`dataBase64`. The former Core-only `url` spelling is rejected, as are remote
URLs, ambiguous bodies, malformed base64 and non-JSON values. Use `dataUrl` for
inline data URLs.

Core's message envelope helper, message creation/revision Actions and the Web
Channel share this codec. `CoreMessageInputEnvelope.payload.content` describes
wire content, while `CoreMessageInput.content` describes in-memory source
content. This codec does not define history hydration or observation semantics.

Generic decoded-body types are owned by runtime content: `ContentJsonValue` and
`ContentBodyValue`. Action inputs and resolved Collection entries share these
contracts; Actions do not import body-value types from Collection read options.
Reference metadata checks in transient preparation and Collection resolution use
`isContentRef`; malformed references are rejected before body reads.

### Decoding and JSON boundary rules

Stored text and JSON use one strict UTF-8 decoder in both content resolution and
Action hydration. Invalid bytes or malformed JSON raise `asset_corrupted` with
the Asset identity and namespace when available. Binary values remain exact byte
copies. Authorization, integrity checks, byte budgets and caching remain with
their existing callers.

Structural JSON validation is shared, with explicit policies:

| Boundary                    | Undefined object fields | Negative zero      | Binary                 |
| --------------------------- | ----------------------- | ------------------ | ---------------------- |
| Media codec                 | May be omitted          | Accepted           | Only media body inputs |
| Action metadata             | Rejected                | Normalized to zero | Rejected               |
| Collection persisted values | Rejected                | Rejected           | Prepared separately    |

All three reject non-finite numbers, cycles, sparse arrays, extra array
properties, accessors, hidden/symbol properties and custom object instances. The
codec retains its depth limit. Ordinary Action input/output serialization is
intentionally unchanged: it still follows JSON serialization semantics, with
declared content prepared separately before persistence.
