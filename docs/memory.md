# Semantic Memory and Application Context

Copilotz memory is a provenance-aware semantic graph. It preserves durable
meaning from conversation and application evidence without treating the raw
transcript, shared documents, or kanban boards as a second document store.

Memory is opt-in in the built-in composition:

```ts
const app = await createCopilotz({
  core: {
    memory: {
      config: {
        triggerEstimatedTokens: 8_000,
        retainRecentEstimatedTokens: 2_000,
      },
    },
  },
  // database, agents, and other plugins
});
```

## Model

Every `memory_record` has one structural form:

- `entity`: a stable referent such as a person, project, or system;
- `assertion`: a proposition with subject, predicate, object, epistemic stance,
  and validity time;
- `occurrence`: an event or change;
- `intent`: a purpose, decision, plan, or action;
- `inquiry`: an open question or material unknown; or
- `procedure`: a reusable workflow, diagnostic, or workaround.

Kinds refine forms. Core examples include `entity.project`, `assertion.state`,
`intent.objective`, `inquiry.question`, and `procedure.diagnostic`. Relations
use the stable kernel `about`, `derived_from`, `same_as`, `supports`,
`contradicts`, `supersedes`, `depends_on`, `contributes_to`, `blocks`, and
`answers`.

Each record carries source references, who asserted it when that identity is
known, which agent recorded it, its consolidation ID, transaction/validity time,
and a form-specific lifecycle. Corrections preserve prior records and explicit
`contradicts` or `supersedes` relations instead of overwriting history. The
prompt's continuity view is derived from current semantic records; there is no
separate canonical continuity object.

## Consolidation lifecycle

Copilotz, not the model, reserves a deterministic source range when the token
threshold is reached. It snapshots application context, then starts an internal
attempt for the same responsible agent using the canonical prompt builder and
provider policy.

Only `consolidate_memory` is granted to that attempt. It is an ordinary durable
tool call using automatic provider tool selection and the normal validation and
execution pipeline. The agent must call it exactly once, or use
`{ outcome: "no_changes" }`. Missing, invalid, multiple, or unauthorized calls
receive one bounded internal repair by default. Internal answers, reasoning,
tool status, and repair attempts do not become public conversation messages.

Evidence is allow-listed from the reserved transcript, its assets and tool
executions, and frozen context contributions. A record cannot cite arbitrary
tenant data or a newer collection version than the one shown to the agent.
Candidate retrieval happens after extraction, independently for each proposed
record. Stable checkpoint, attempt, execution, record, and relation identities
make delivery recovery idempotent.

The reservation processor starts this lifecycle in a detached durable settlement
scope. Consolidation therefore remains retryable and recoverable but does not
delay or fail the user-facing `run.done`. Every checkpoint, attempt, tool
execution, repair, and final commit retains causation to the triggering message
while inheriting the detached scope automatically.

After reconciliation, Copilotz commits every new or updated semantic record,
relation, lifecycle change, frozen snapshot asset link, the internal
`memory.consolidation.committed` event, and the ready checkpoint in one database
transaction. A failure at any point rolls the entire aggregate back; history
cutover therefore cannot observe a partial semantic graph.

## Application context plugins

Use a `context` resource to add bounded application state to conversation,
memory consolidation, or both:

```ts
import {
  defineContextResource,
  definePlugin,
} from "jsr:@copilotz/copilotz@^0.59.0";

const workspaceContext = defineContextResource({
  id: "compass.workspace",
  type: "context",
  purposes: ["conversation", "memory_consolidation"],
  async contribute(input) {
    const documents = await input.collections.sharedDocument.list({
      where: { threadId: input.thread.id },
      limit: 20,
    });
    const current = documents.at(-1);
    if (!current) return null;

    return {
      id: `shared-document:${current.id}`,
      title: "Compass shared document",
      role: "evidence",
      content: {
        type: "json",
        value: {
          title: current.title,
          body: current.body,
          updatedAt: current.updatedAt,
        },
      },
      source: {
        type: "collection_record",
        collection: "sharedDocument",
        id: current.id,
        updatedAt: current.updatedAt,
      },
    };
  },
});

export const workspacePlugin = definePlugin({
  manifest: {
    id: "@compass/workspace-context",
    version: "1.0.0",
    provides: { context: [workspaceContext.id] },
  },
  resources: { context: [workspaceContext] },
});
```

`role: "context"` provides untrusted interpretive data and cannot be the sole
source of a memory. `role: "evidence"` requires an exact `source`. Copilotz
prepares the contribution through the canonical content/asset layer and stores
the frozen references on the pending checkpoint before calling the provider.
Retries and process recovery reuse those references rather than re-reading a
newer application version.

Application context is always labelled as data, never instructions. Only the
built-in `copilotz.long_term` context resource can advance transcript cutover;
application plugins cannot hide history.

## Custom kinds

Kinds are ordinary stable-ID plugin resources and follow normal override
precedence:

```ts
const incidentKind = defineMemoryKind({
  id: "compass.incident",
  form: "occurrence",
  description: "A material Compass production incident.",
  schema: {
    type: "object",
    required: ["attributes"],
    properties: {
      attributes: {
        type: "object",
        required: ["severity"],
        properties: {
          severity: { enum: ["low", "medium", "high", "critical"] },
        },
      },
    },
  },
});

const memoryKindsPlugin = definePlugin({
  manifest: {
    id: "@compass/memory-kinds",
    version: "1.0.0",
    provides: { memoryKinds: [incidentKind.id] },
  },
  resources: { memoryKinds: [incidentKind] },
});
```

The composed kind registry drives maintenance instructions and validates the
kind-specific persisted `data`. A later plugin with the same kind ID replaces
the earlier definition.

## Query tools and grants

The memory plugin provides four ordinary query/lifecycle tools:

- `list_knowledge_spaces`
- `search_memory`
- `inspect_memory`
- `set_memory_status`

They are not automatically inherited. Grant only the operations an agent needs:

```ts
const agent = {
  id: "north",
  name: "North",
  role: "assistant",
  capabilities: {
    tools: ["search_memory", "inspect_memory"],
  },
};
```

Space access is resolved from the active thread. Search returns current records
by default and can include historical records. Inspection returns provenance,
time, and visible relations. Status changes validate the lifecycle allowed for
the record's form and never erase historical evidence.

## Upgrade from the mixed v3 memory model

Existing event-native databases containing `brain_node` records require the
isolated one-way migration before this memory runtime is enabled:

```ts
import {
  upgradeMemoryV4Schemas,
} from "jsr:@copilotz/copilotz@^0.59.0/migration/memory-v4";

const results = await upgradeMemoryV4Schemas(session);
```

The migration refuses to run while a legacy memory checkpoint is pending. It
preserves record IDs, maps legacy kinds/lifecycles into semantic forms,
preserves provenance and temporal history, materializes continuity-only values
as ordinary records, converts memory edge types, removes duplicated checkpoint
continuity state, and is idempotent. It is not imported by the normal runtime.
