# Semantic Memory

Long-term memory is an optional plugin, not a runtime service. It owns its
Collections, native Actions, Tool Resources, and durable Processors.

```ts
import { createLongTermMemoryPlugin } from "@copilotz/copilotz/memory";

const memoryPlugin = createLongTermMemoryPlugin({
  config: {
    triggerEstimatedTokens: 8_000,
    retainRecentEstimatedTokens: 2_000,
  },
});
```

Memory uses the owning Agent's ordinary Model selection, credentials,
instructions, Context, Skills, and explicitly granted Tool catalog. Add
`consolidate_memory` to the `capabilities.tools` of every Agent that may write
semantic memory.

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

The internal maintenance instruction is appended as the last private Message,
after the same ordinary history and prompt prefix used by the Agent. This keeps
the Agent's instructions, Context, Skills, tools, Model ordering, and credential
routing identical to a user-facing turn and preserves provider prompt-cache
opportunities. The private scope is never accepted from HTTP history input.

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
