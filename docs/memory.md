# Semantic Memory

Long-term memory is an optional plugin, not a runtime service. It owns its
Collections, native Actions, Tool Resources, and durable Processors.

```ts
import { createCopilotz } from "@copilotz/copilotz";
import { memoryPlugin } from "@copilotz/copilotz/memory";

const application = await createCopilotz({
  plugins: [memoryPlugin],
  resources: {
    memory: {
      config: {
        triggerEstimatedTokens: 8_000,
        retainRecentEstimatedTokens: 2_000,
      },
    },
  },
});
```

Memory uses the owning Agent's ordinary Model selection, credentials,
instructions, Context, Skills, and explicitly granted Tool catalog. Add
`consolidate_memory` to the `capabilities.tools` of every Agent that may write
semantic memory.

## Shared work context

[Core Spaces](spaces.md) add read-only access to peer Thread producer scopes.
Space-derived access is resolved consistently for search, consolidation and
prompt context, and revoked by detach, move, archive or removal.

## Durable model

Memory records use one ontology with the forms `entity`, `assertion`,
`occurrence`, `intent`, `inquiry`, and `procedure`. Relations include `about`,
`derived_from`, `same_as`, `supports`, `contradicts`, `supersedes`,
`depends_on`, `contributes_to`, `blocks`, and `answers`.

Records preserve source references, asserting/recording identity, epistemic and
temporal state, lifecycle, and consolidation provenance. Corrections add
explicit relations rather than silently overwriting historical evidence.

## Consolidation

The plugin reserves a deterministic source range after its token threshold, then
creates one detached internal Agent turn. It is routed by Core like every other
turn and ends only when that scoped turn successfully calls
`consolidate_memory`. A missing completion call receives one scoped repair;
provider failures and cancellation settle the checkpoint without exposing the
internal workflow in normal history.

Collection state stores every checkpoint and terminal status, including
`cancelled`. Restart recovery reuses deterministic Message, LLM Action,
Tool-plan, and checkpoint identities; it cannot bill a second provider request
merely because projection or checkpoint settlement was interrupted.

New/updated records, relations, frozen evidence refs, lifecycle changes, and the
ready checkpoint commit atomically.

Core prepares each new invocation from the latest authorized history. A verified
checkpoint supplies the lower boundary; the trigger message is not an upper
cutoff. There is no moving 1,000-message window or silent LLM input trimming. An
already captured Action keeps its original request during replay.

A checkpoint can replace raw history only when its coverage matches the Agent,
visibility scope, active branch and source range. Its required `continuity`
summary preserves the current task, constraints, useful results and outstanding
work. Older semantic checkpoints remain readable but do not certify a cutoff.
The first certified range begins at the start of eligible history; later ranges
continue after the previous certified boundary and carry its summary forward.

Compaction takes bounded chronological chunks and may cross unfinished Tool or
Ask calls. Execution continues independently; continuity preserves outstanding
work, and later results retain their plan and call identities. The private turn
carries an authorized source snapshot as Message and Asset references plus
frozen application Context. Core prepares that history and Context through its
ordinary input pipeline, preserving typed media, reasoning and Tool
relationships. The consolidation instruction and source-ID manifest follow the
prepared history; the owning Agent's instructions, Tool catalog, Model selection
and authentication stay in effect. For the same Context and Model, the normal
provider prompt prefix is reusable. The private scope is never accepted from
HTTP history input.

The immutable private root stores the frozen source once. LLM and Tool
continuations, including bounded repair and process restarts, carry only its
Message ID and content digest. Core resolves the root from the existing scoped
history batch and checks its namespace, thread, scope, owner and digest. The
maintenance suffix preserves its own wire boundary even when source history ends
with a user turn, keeping the ordinary provider prefix intact.

History and Context share batched Asset metadata and body resolution. Range
selection estimates the typed source through the ordinary LLM wire formatter;
binary storage bytes remain separate from model token estimates. Source bodies
are not opened again merely to construct the maintenance instruction. Resume
preparation verifies stored Message snapshots, and checkpoint settlement still
verifies authorized coverage. Preparation failures settle the owning private
checkpoint instead of leaving it pending.

Ordinary turn preparation checks the owning Agent's configured history threshold
using the transcript already prepared for that turn. Peer Agent, human and Tool
history therefore count toward that Agent's eligibility. Below the threshold,
this check performs no SQL or additional Asset resolution. An eligible bounded
checkpoint runs in the background while the ordinary reply proceeds; only a
ready certified checkpoint advances the boundary. The existing message-created
reservation path still covers history produced when an Agent finishes a turn.

Core preflights the same formatted input used by execution. If necessary, it
waits for certified compaction progress and rebuilds the request. Waiting is
cancellable; repeated attempts at the same boundary fail instead of looping.
Unavailable compaction, a failed checkpoint, an indivisible oversized input, or
failure to make progress produces an input-limit failure instead of dropping
history. A source change invalidates its pending checkpoint and ends that
maintenance task with the `invalidated` outcome; it cannot advance coverage.

`consolidate_memory` may also be called during an ordinary turn. Core does not
special-case that Tool: Memory derives a deterministic on-demand checkpoint from
trusted Tool provenance, and the Agent continues after the Tool result. Only
Memory's own private turn carries the generic Core completion condition that
ends after a successful consolidation.

## Tools and grants

The plugin contributes native aliases:

- `list_knowledge_spaces`
- `search_memory`
- `inspect_memory`
- `set_memory_status`

Installing Memory does not grant those tools. Select exact aliases in the
Agent's `capabilities.tools` list.

Custom kinds use `defineMemoryKind` and compose under `resources.memory.kinds`.

## Vector retrieval

Supply an embedding function as `adapters.memoryEmbedding.default` and declare
`resources.memory.embeddingProfile` with `model`, `revision`, `dimensions`, and
`metric` (`cosine`, `l2`, or `innerProduct`). The profile must describe the
vectors actually returned by the adapter. No plugin factory captures
configuration.

The host explicitly provisions optional vector storage after the base schema:

```ts
import { provisionVectorStorage } from "@copilotz/copilotz/persistence";
await provisionVectorStorage(session, databaseSchema);
```

PostgreSQL must have pgvector installed. For PGlite, open persistence with
`pgliteExtensions: ["vector"]`. Applications without vectors require neither the
extension nor the vector table.

Consolidation writes Memory records and their vector projections in the same
transaction. `searchMemory` and consolidation candidate retrieval both use SQL
distance ordering. Namespace, readable Memory spaces, editorial validity,
status, form and kind filters apply before LIMIT. Different profiles never mix.
Changing the source summary makes its old vector ineligible until it is
recomputed.

Vectors live in a typed pgvector column, outside `nodes.data`. Durable vector
facts in Event bodies support current-format projection replay; deleting an
owner cascades its vector projection. An Asset reference is optional. No HNSW
index is created: exact distance search is the initial implementation.

Without an embedder, Memory uses its explicit bounded lexical path. Configured
embedding failures are errors, not silent lexical fallbacks.

## Fresh schema

This release requires a fresh v5 schema. It includes no data migration,
backfill, legacy JSON-vector reader, or dual writes. Existing application
deployments are outside this library milestone.
