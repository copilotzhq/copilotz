# Runtime domain boundary audit

Date: 2026-09-15. Source: local implementation commit `7e06bfb`.

## Conclusion

Runtime has no detected production import dependency on concrete plugins, but it
still embeds conversational and tool concepts in public contracts, storage, and
queries. Import isolation does not establish semantic isolation.

Seven findings are grouped below. The thread envelope and thread operation
queries are related parts of one architectural problem. This is an audit and
proposed remediation sequence, not an implemented migration.

## Scope and method

Searched all 114 production TypeScript files under `runtime/`, excluding tests
and test support, for domain names, compound identifiers, plugin imports, SQL
columns, and specialized contracts. Traced the matching implementation paths and
representative consumers in Core, Core Collections, server operations, and the
v4 migration. Reviewed generic matches to avoid treating infrastructure terms as
plugin leaks. Ran `scripts/check-plugin-boundaries.ts`; it passed.

This is a static boundary audit, not a new authorization, performance, or data
migration validation. The earlier full test result applies to the implementation
commit, not to the proposed changes below.

## Findings

### 1. High: conversations are a native event/storage dimension

Evidence:

- [Event contracts](../runtime/events/types.ts) put `threadId` on durable and
  ephemeral events and their drafts.
- [Event schema](../runtime/events/schema.ts) requires `events.thread_id` and
  provisions the `(namespace, thread_id, position)` index.
- [Event store](../runtime/events/store.ts) persists, deduplicates against, and
  filters that field.
- [Event hub](../runtime/events/hub.ts),
  [Processor matching](../runtime/plugins/match.ts), and
  [Processor declarations](../runtime/plugins/processor.ts) understand thread
  selection explicitly.
- [Collection write options](../runtime/collections/types.ts) and
  [Collection kernel](../runtime/collections/kernel.ts) carry thread identity
  into generic mutations. Engine replay forwards the thread filter too.

Why this leaks: every runtime deployment reserves a conversation-specific
storage and filtering dimension, even without Core installed. This is active
behavior, not merely a type hint.

Ownership: Core/Core Collections should declare conversation membership. Runtime
can supply generic indexed event associations and matching, if needed by the
demonstrated query workloads. Define their semantics before choosing an API; do
not simply rename `threadId` to `scopeId` while retaining thread-only
assumptions. An event's subject is not necessarily its containing conversation,
so replacing threadId with subjectId would lose information.

Required validation: durable/live matching parity, deduplication equality,
collection-event propagation, namespace isolation, pagination, restart/replay,
and existing database migration. Preserve efficient indexed queries.

### 2. High: the generic operation catalog implements conversation queries

Evidence: [Operation catalog](../runtime/streams/catalog.ts), especially
`belongsToThread`, `listForThread`, and `threadEventWatermark`.

These methods inspect both `operation.metadata.operationMetadata.threadId` and
joined `events.thread_id`. They encode domain relationship semantics inside the
runtime. [Server operations](../server/operations.ts) uses them for conversation
observation and attachment checks.

Ownership: the Core/server conversation integration should own thread-specific
queries and access decisions. Runtime should expose only the generic operation
and event association/query capabilities those queries actually require.

Required validation: preserve the union of explicit operation association and
association through emitted events; attachment authorization, active-operation
discovery, after-position behavior, watermarks, and replay checkpoints must
remain correct. Neither a metadata-only replacement nor an unbounded scan is an
adequate substitute.

### 3. High: runtime visibility contracts encode tool and participant policy

Evidence: [EventVisibility](../runtime/events/types.ts) enumerates
`participants`, `participantIds`, `tool`, `requesterId`, `requester_only`, and
`public_status`.

Important correction to the preceding discussion: inspected runtime paths
store/copy/match this policy, and the transport validates its outer shape. They
do not implement the tool authorization rules. Core/Core Collections interpret
those rules, including in
[history projections](../plugins/core-collections/internal/projections.ts) and
[tool orchestration](../plugins/core/internal/tool-plan.ts). Therefore the
confirmed leak is ownership of the policy contract; this audit did not find a
runtime tool-authorization dispatcher.

Ownership: Core owns participant membership, requester identity, and the
relationship between public invocation status and private arguments/results.
Move those domain definitions there. Decide explicitly whether the runtime needs
a small generic audience contract or only opaque plugin policy metadata; do not
invent an authorization framework just to replace the names. Namespace isolation
remains a runtime responsibility.

Required validation: requester-only history, public-status redaction, argument
and result Asset resolution, live outputs, replay, and server observation.
Changing a tag without preserving these consumer semantics is insufficient.

### 4. Medium: generic events have a conversational routing contract

Evidence: [EventRouting](../runtime/events/types.ts) is described as
"Conversational routing" and contains `senderId` and `recipientIds`. Collection
writes and event transport carry it; Processor matching structurally matches it.
Runtime delivery routing itself is implemented separately through
Processor/delivery/workload infrastructure.

Ownership: Core and Channels should define sender/recipient meaning. Runtime can
carry generic matchable event attributes without declaring conversational
identities. Reuse existing metadata/matching where sufficient; avoid adding a
parallel routing framework.

Required validation: channel ingress, recipient selection, Processor matching,
causal writes, and durable/live envelope round trips.

### 5. Low: content role suggestions contain plugin vocabulary

Evidence: [ContentRole](../runtime/content/types.ts) lists `reasoning`,
`tool.arguments`, `tool.output`, `tool.projected_output`, `tool.error_detail`,
`transcript`, `recording`, `document.source`, and `provider.trace`. These types
propagate into Stream descriptors and content input APIs.

The fields already accept arbitrary strings; no runtime branch on the
plugin-specific role names was found. Generic role transformations and default
body/attachment handling remain valid infrastructure.

Ownership: runtime accepts role strings. Core/Tools, LLM, and Knowledge export
any useful domain-specific role types/constants. Preserve existing stored role
values; changing ownership does not require rewriting Asset data.

### 6. Low: ephemeral event types recommend plugin events

Evidence: [EphemeralEvent.type](../runtime/events/types.ts) explicitly lists
`reasoning.delta`, `tool_call.delta`, and `tool_output.delta`, alongside media
examples, while already allowing arbitrary strings. Runtime does not dispatch by
these domain names in the inspected production code.

Ownership: runtime uses a string event type; owning plugins supply typed domain
event unions. Existing event names can remain unchanged on the wire.

### 7. Medium: mandatory node storage reserves an embedding column

Evidence: [Core schema columns and DDL](../runtime/events/schema.ts) require and
create `nodes.embedding JSONB`. It is the only production runtime occurrence of
embedding storage; no runtime vector-search or embedding execution was found.
Memory and Knowledge declare embedding fields in their own Collections. The
[v4 migration](../migration/v4/index.ts) also reads the physical column in its
projection snapshot.

Memory embeddings are used, but through a different storage path: consolidation
calls `context.adapters.memoryEmbedding.default`, assigns the resulting vector
to the Memory record's `embedding` field, and the Collection reducer serializes
the whole record into `nodes.data`. Thus the vector is in
`nodes.data.embedding`, not the physical `nodes.embedding` column. Memory's
consolidation candidate retrieval reads that record field and computes cosine
similarity in plugin code (with lexical fallback). The public `searchMemory`
Action currently uses lexical scoring. This distinction is confirmed by
[consolidation](../plugins/memory/actions/consolidate-memory/index.ts),
[retrieval](../plugins/memory/internal/retrieval.ts), and the
[Collection reducer](../runtime/collections/reducer.ts).

Assessment: a legacy domain-specific storage reservation, rather than a live
embedding subsystem. A vector capability could be generic infrastructure if
explicitly designed as such, but an otherwise-unused mandatory column does not
establish that contract.

Ownership: Memory/Knowledge data definitions, or a separately justified generic
indexing capability. Inventory existing database values and migration invariants
before removing the column. Do not silently drop it or infer that it is empty
from the absence of runtime readers.

## Things that should remain in runtime

- Collections, Actions, Processors, generic plugin composition, Resources, and
  Adapters; synchronous contributions contain no concrete-plugin branches.
- Tenant namespaces, schema isolation, causal/correlation IDs, operations,
  delivery retries, leases, settlement, cancellation, and replay cursors.
- Assets, byte streams, MIME/content kinds, generic content roles and content
  retention. These support more than conversational applications.
- SQL/PostgreSQL/PGlite and filesystem/S3/GCS storage adapters. Their provider
  dependencies are infrastructure placement concerns, not LLM-plugin leaks.
- In-memory stores (`kind: "memory"`), recovery participants, transport
  channels, error messages, and delivery scheduling. These names are false
  positives for Memory, Participant, Channel, Message, and Schedules plugin
  concepts.

No additional production runtime implementation of model selection, prompts, LLM
execution, agent planning, semantic memory retrieval, skills, finance, knowledge
ingestion, or channel-provider behavior was found in this audit. Runtime
integration tests may deliberately exercise plugins; those imports are not
production boundary violations.

## Recommended remediation sequence

1. Move role/event-name suggestions to owning plugins; keep serialized strings.
2. Move conversational routing and visibility contracts, and specify where
   authorization remains enforced. Preserve existing privacy regressions.
3. Design the smallest generic event/operation association mechanism needed by
   the existing thread queries. Move conversation queries to their owner and
   migrate storage/filtering together; verify replay and query performance.
4. Resolve the legacy embedding column through an explicit schema migration
   decision with data-preservation evidence.
5. Extend architecture regression coverage. The current import-graph check
   cannot detect copied domain types, specialized methods, or SQL columns. Add
   focused assertions against these specific regressions and a non-chat runtime
   fixture; avoid banning ambiguous words such as "message" or "memory".

Keep the milestone under review until the scope of this additional cleanup is
settled. This document does not claim the runtime is domain-neutral today.

## Subsequent scope decision — 2026-09-15

The user approved planning a new refactor milestone covering all findings,
merging Core Collections and Tool authoring into Core, and replacing plugin
internal/dependencies folders with strict primitive-local/shared ownership. The
prior migration precautions above are superseded for this new milestone: no data
migration/backfill or compatibility machinery is required. Implement against
fresh schemas/data, document the break, and do not delete an existing database
as part of planning. Current-format transactional integrity, privacy, replay and
recovery still require regression coverage.
