# Semantic Memory

Long-term memory is an optional plugin, not a runtime service. It owns its
Collections, native Actions, Tool Resources, and durable Processors.

```ts
import { createLongTermMemoryPlugin } from "@copilotz/copilotz/memory";

const memoryPlugin = createLongTermMemoryPlugin({
  models: ["memoryModel", "memoryBackup"],
  config: {
    triggerEstimatedTokens: 8_000,
    retainRecentEstimatedTokens: 2_000,
  },
});
```

`models` is a non-empty ordered list of aliases in the application's
`resources.models` map. Memory never infers an Agent's Models; its maintenance
Action calls the composed `llm.call` Action explicitly and uses the same ordered
fallback semantics as Core.

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
runs detached durable maintenance. The model may call only `consolidate_memory`;
missing, multiple, unauthorized, or schema-invalid calls receive a bounded
contract repair. Provider, cancellation, persistence, and infrastructure
failures are not reinterpreted as prompt-repair opportunities.

Collection state stores every checkpoint and terminal status, including
`cancelled`. Restart recovery reuses the durable parent Action and cannot bill a
second LLM call merely because checkpoint settlement was interrupted.

New/updated records, relations, frozen evidence refs, lifecycle changes, and the
ready checkpoint commit atomically.

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
