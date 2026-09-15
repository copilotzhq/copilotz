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
work, and later results retain their plan and call identities. The private task
contains its authorized source text and prior context; its own scoped transcript
replaces replaying the whole public thread. The owning Agent's instructions,
tools, model selection and authentication stay in effect. The private scope is
never accepted from HTTP history input.

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

Custom kinds use `defineMemoryKind` and compose under `resources.memoryKinds`.
Optional embedding is an application-owned `memoryEmbedding` Adapter or the
`embed` option captured by the plugin factory.

## Migration

There is no standalone memory migration in 0.62. The sole deployed-data
migration is [`/migration/v4`](migration-v4.md); it archives retired legacy
memory/workflow records and emits final source facts for retained v4
Collections. Fresh Mobizap/Compass deployments start on an empty v4 schema.
