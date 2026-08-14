# Application Resilience and Memory Refactor Plan

Status: memory and application-resilience designs implemented; release
verification pending.

This document freezes two related runtime designs:

- application recovery after persistence loss; and
- the provenance-aware memory ontology, consolidation workflow, and plugin
  context contract.

Both designs rely on the same durable boundary. Work may be retried after a
runtime generation is replaced, but indeterminate mutations are never replayed
without their original idempotency identity.

## Application resilience

Copilotz should recover from persistence loss without relying on the process
manager to replace an otherwise healthy application instance. This is defense in
depth: Copilotz replaces an unavailable Ominipg connection, restores application
processing, and leaves the deployment platform as the final circuit breaker.

### Ownership boundary

Copilotz can reconnect automatically only when the application gives it the
capability to create a new database connection. Passing an already-open database
keeps the existing injected-infrastructure contract: the caller owns that
database, and Copilotz neither closes nor replaces it.

The intended distinction is:

```ts
// Copilotz owns every database returned by connect and may replace it.
const app = await createCopilotz(
  {
    database: {
      connect: () => Ominipg.connect({ url }),
    },
  },
  {
    onUnavailable,
    onReconnecting,
    onReady,
  },
);

// The application owns this database. Copilotz never replaces it implicitly.
const app = await createCopilotz({ database });
```

Database configuration such as `{ url }` is also Copilotz-owned and therefore
reconnectable. The connector form exists for applications that need to obtain
credentials, configure providers, or otherwise control creation of each
physical connection. Ownership remains explicit and factory/closure based.

### Stable facade and runtime generations

The application returned to consumers remains stable while its internal runtime
may move between generations:

```text
Stable Copilotz application, plugins, repositories, Gateway, and Worker
        |
        +-- stable persistence facade
                    |
                    +-- physical DB generation 1  (retired)
                    |
                    +-- physical DB generation 2  (active)
```

Every component captures the stable persistence facade rather than one physical
database. Reconnection can therefore replace and fence the physical generation
without reconstructing plugin composition, repositories, Gateway, Worker,
delivery pumps, or database scopes. If a future adapter cannot preserve that
stable handle, the same public contract permits rebuilding the affected runtime
generation instead.

### Recovery lifecycle

When persistence becomes unavailable, Copilotz should:

1. Mark the current generation unavailable and stop admitting new work to it.
2. Reject affected in-flight operations with an explicit indeterminate error.
   Never automatically replay an operation that may already have reached the
   database.
3. Share one reconnect attempt among all callers.
4. Open a new physical database generation behind the stable facade.
5. Atomically route new operations through that generation and fence late
   results from the retired generation.
6. Recover durable pending, retrying, and expired deliveries from the database.
7. Dispose of the previous generation after it can no longer receive work.

Database-dependent requests may wait for a short, bounded recovery interval. If
recovery is not ready within that interval, HTTP adapters should return
`503 Service Unavailable` with `Retry-After`; they must not hang indefinitely.

Active realtime attachments are not silently transferred between generations.
They receive a terminal availability error and reconnect through the stable
application endpoint. Durable semantic state remains recoverable, while raw
stream frames remain ephemeral.

### No-replay boundary

Reconnection and replay are separate decisions. A connection loss can leave an
operation in an unknown state: PostgreSQL may have committed it even though the
client did not receive the result. Copilotz therefore does not replay that
operation automatically.

Recovery instead relies on existing durable semantics:

- mutations use stable operation/idempotency keys;
- committed events and delivery obligations are rediscovered after reconnect;
- expired delivery leases are reclaimed through normal delivery recovery;
- an uncommitted user operation fails explicitly and may be retried by its
  caller with the same operation key.

### Layer responsibilities

#### Ominipg

- Provide one physical database connection per Copilotz-owned generation.
- Fail operations when its session or underlying connection is unavailable.
- Close cleanly when Copilotz retires the generation.
- Never close an injected Oxian dispatcher.

#### Copilotz

- Observe persistence availability.
- Pause admission and delivery dispatch while unavailable.
- Preserve a stable persistence facade and replace owned physical connections.
- Fence late results and fail indeterminate in-flight operations without replay.
- Resume durable delivery recovery after persistence is ready.
- Terminate active attachments with a retryable availability error.
- Rebuild a larger application generation only when a future adapter cannot
  preserve the stable persistence handle.
- Expose lifecycle callbacks without prescribing logging, alerting, or process
  termination policy.

#### Application and deployment platform

- An application such as Compass supplies database credentials/configuration
  through the connection capability and decides how lifecycle events are
  observed.
- The application terminates the process only after repeated or unrecoverable
  recovery failure.
- Cloud Run or another process manager is the last safety net, not the primary
  reconnection mechanism.

### Acceptance criteria

- A closed Ominipg session does not permanently poison an otherwise healthy
  Copilotz process.
- Concurrent requests trigger one recovery attempt rather than a reconnect
  stampede.
- New requests never reach an obsolete runtime generation.
- In-flight operations are never silently replayed across the no-replay
  boundary.
- Pending durable deliveries resume after recovery without duplicate domain
  mutations.
- Short recovery windows produce bounded waiting; longer outages produce a clear
  retryable availability response.
- Injected databases, dispatchers, Hypervisors, and Workers remain
  application-owned.
- Repeated recovery failure can still deliberately terminate the instance so the
  deployment platform replaces it.

## Memory refactor

### First principles

Copilotz memory is not a bag of summaries and must not be modeled as one flat
enum of unrelated kinds. It is a temporal, provenance-aware graph with two
planes:

```text
Evidence plane
  messages / tool executions / assets / external records / application records
                                  |
                                  | provenance
                                  v
Semantic memory plane
  entity / assertion / occurrence / intent / inquiry / procedure
                                  |
                                  v
Derived views
  continuity / profile / timeline / decisions / open work / procedures
```

The evidence plane contains canonical records of what entered or happened in
Copilotz. It remains immutable evidence and is not copied into semantic memory.
Semantic records cite it through source references.

The semantic plane contains the agent's durable interpretation of evidence. It
uses a small closed set of structural forms and an extensible plugin-defined
kind vocabulary:

```ts
type MemoryForm =
  | "entity"
  | "assertion"
  | "occurrence"
  | "intent"
  | "inquiry"
  | "procedure";
```

`form` determines the record's structure and lifecycle semantics. `kind`
describes its application-facing role. Core forms remain stable; plugins may
register additional namespaced kinds without inventing new structural models.

### Semantic forms

#### Entity

An entity is a stable referent such as a person, agent, organization, project,
system, document, product, concept, procedure subject, or location. Entities may
have aliases and external IDs. Similar labels alone are not sufficient to merge
identities.

#### Assertion

An assertion is a proposition presented as true, false, possible, preferred,
required, or inferred. Useful built-in kinds include `identity`, `state`,
`preference`, `constraint`, `criterion`, `risk`, `capability`, `relationship`,
`policy`, `observation`, and `lesson`.

`fact` and `claim` cease to be sibling kinds. Every proposition is an assertion.
Whether a reader accepts it depends on provenance, stance, authority, evidence,
and temporal validity. Conflicting assertions are preserved and related rather
than silently overwritten.

#### Occurrence

An occurrence represents something meaningful that happened, changed, failed, or
is scheduled. It is distinct from its evidence: a tool-execution record may be
the source for a semantic occurrence describing a deployment failure.

#### Intent

An intent is a future-directed desired state or commitment. Built-in kinds are
`purpose`, `objective`, `decision`, `plan`, and `action`. A decision remains in
force until completed, cancelled, retracted, or superseded.

#### Inquiry

An inquiry is an unresolved information need. Built-in kinds include `question`,
`unknown`, and `validation_needed`. Explicit inquiries allow an agent to
recognize missing knowledge and abstain instead of inventing an answer. An
assumption is normally an assertion with an assumed or tentative epistemic
position, not an inquiry.

#### Procedure

A procedure is reusable operational knowledge such as a workflow, playbook,
diagnostic, workaround, tool-usage pattern, or environment gotcha. A procedure
differs from a plan: a plan is tied to a current objective, while a procedure
describes how similar work should be performed again. Procedures may later be
promoted into Copilotz skills, but memory does not perform that promotion
implicitly.

### Independent record dimensions

The following concerns are independent facets and must not become additional
top-level forms.

Every persisted semantic record has this common foundation. Form-specific fields
extend it without duplicating provenance or lifecycle data:

```ts
type MemoryRecordBase = Readonly<{
  id: string;
  memorySpaceId: string;
  form: MemoryForm;
  kind: string;
  summary: string;
  content?: ContentRef;
  temporal: MemoryTemporal;
  provenance: MemoryProvenance;
  metadata?: Readonly<Record<string, unknown>>;
}>;
```

`summary` is the bounded, self-contained semantic representation used for
reading and retrieval. Larger bodies remain canonical asset-backed content.

#### Time

```ts
type MemoryTemporal = Readonly<{
  validFrom?: string;
  validTo?: string;
  recordedAt: string;
  invalidatedAt?: string;
}>;
```

`validFrom` and `validTo` describe when a record applied in the represented
world. `recordedAt` and `invalidatedAt` describe when Copilotz knew or stopped
accepting it. Corrections create a new record and close, retract, or supersede
the previous record; they do not erase history.

#### Epistemic position

```ts
type MemoryEpistemic = Readonly<{
  basis: "observed" | "reported" | "inferred" | "assumed";
  stance: "affirmed" | "denied" | "tentative" | "disputed";
}>;
```

Model-authored numeric confidence is not required by the consolidation tool. If
Copilotz later calculates extraction confidence, it remains separate from the
source's certainty and from the truth of the assertion.

#### Provenance and responsibility

The model must not conflate who expressed a proposition, who extracted it, who
or what it concerns, who owns an intent, and who may read it:

```ts
type MemoryProvenance = Readonly<{
  sources: readonly MemorySourceRef[];
  assertedBy?: NodeRef;
  recordedBy: NodeRef;
  derivedFromMemoryIds?: readonly string[];
  consolidationId: string;
}>;
```

Copilotz injects `recordedBy`, `consolidationId`, transaction time, thread,
agent, and checkpoint identity. The model cannot choose or override them. Memory
spaces continue to control access and write authority independently of
authorship or ownership.

#### Lifecycle

Lifecycle values depend on the structural form:

- assertions: current, superseded, retracted, or disputed;
- intents: proposed, active, completed, cancelled, or superseded;
- inquiries: open, answered, or obsolete;
- procedures: active or deprecated;
- entities: active, merged, or archived; and
- occurrences: scheduled, happened, or cancelled.

One generic `active | superseded | archived` lifecycle is insufficient.

### Relations

Copilotz keeps a small stable relation kernel:

```text
about
derived_from
same_as
supports
contradicts
supersedes
depends_on
contributes_to
blocks
answers
```

Domain propositions do not become arbitrary graph-edge types. They belong in
assertions as subject, predicate, and object/value data. This keeps graph
traversal stable while allowing plugin-specific knowledge.

### Current-kind migration

The current memory vocabulary maps to the target ontology as follows:

| Current representation        | Target representation                       |
| ----------------------------- | ------------------------------------------- |
| `entity`                      | entity                                      |
| `fact`, `claim`               | assertion                                   |
| `event`                       | occurrence                                  |
| `preference`                  | assertion / preference                      |
| `constraint`                  | assertion / constraint                      |
| `challenge`                   | assertion / challenge                       |
| `current_state`               | assertion / state                           |
| `risk`                        | assertion / risk                            |
| success and decision criteria | assertion / criterion related to its intent |
| `purpose`, `desired_outcome`  | intent / purpose or objective               |
| `decision`                    | intent / decision                           |
| `active_approach`             | intent / plan                               |
| `task`, `next_action`         | intent / action                             |
| `open_question`               | inquiry / question                          |

The information currently carried by `continuityPatch` remains, but it is stored
as ordinary assertions, intents, and inquiries. Continuity becomes a derived,
optionally cached view over current records:

```text
current objective  <- active objective intents
current plan       <- active plan intents
next actions       <- planned or active actions
open questions     <- open inquiries
current state      <- currently valid state assertions
constraints        <- current constraint assertions
risks              <- current risk assertions
decisions          <- active decision intents
```

Likewise, `knowledge` versus `working` is not an intrinsic record layer. Working
memory means accessible, active, currently valid, and relevant to the present
context. The consolidation checkpoint remains operational state rather than a
semantic parent of the memories it produced.

### Declarative kind registry

The built-in and plugin-defined kinds are data, not hardcoded prompt prose:

```ts
type MemoryKindDefinition = Readonly<{
  id: string;
  form: MemoryForm;
  description: string;
  schema?: Readonly<Record<string, unknown>>;
}>;
```

Plugin composition produces one registry. That registry drives tool-schema
validation, consolidation instructions, query facets, and documentation. Later
resources with the same stable kind ID follow normal plugin override rules.
Custom kinds should be namespaced.

## Native consolidation tool

### Responsibility boundary

Copilotz decides when consolidation is due. The agent decides what the reserved
evidence means.

The model never monitors token thresholds and cannot select an arbitrary source
range. The existing deterministic reservation policy creates a pending
checkpoint when the estimated-token threshold is crossed. Copilotz then starts
an internal memory attempt for the same agent.

`consolidate_memory` is an ordinary native tool executed by the ordinary durable
tool pipeline. It is dynamically granted only during that memory attempt and is
absent from normal conversation turns. Application tools, `ask`, terminal,
browser, and other side-effecting tools are not granted during consolidation.

There is no provider-forced tool choice, JSON response mode, or separate direct
LLM parser. The provider uses normal automatic tool selection, and the agent's
call is validated by the existing Copilotz tool-call and execution machinery.

### Source references

```ts
type MemorySourceRef =
  | Readonly<{ type: "message"; id: string }>
  | Readonly<{ type: "tool_execution"; id: string }>
  | Readonly<{ type: "asset"; id: string }>
  | Readonly<{ type: "external"; id: string }>
  | Readonly<{
    type: "collection_record";
    collection: string;
    id: string;
    version?: string | number;
    updatedAt?: string;
    fragment?: string;
  }>;
```

Every proposed record cites at least one source authorized for the checkpoint.
The tool rejects arbitrary tenant records and versions that were not included in
the frozen source catalog.

References inside one proposal use this shape:

```ts
type ProposedMemoryRef =
  | Readonly<{ localId: string }>
  | Readonly<{ memoryId: string }>
  | Readonly<{ node: { type: string; id: string } }>;
```

A `localId` names another proposal in the same call. A `memoryId` is allowed
only when that existing memory was shown to the agent. A domain-node reference
must be visible in the scoped application context.

### Input shape

The internal ontology may use a discriminated union, but the LLM-facing tool
uses separate arrays because providers generally validate that shape more
reliably than a large nested union:

```ts
type ConsolidateMemoryInput = Readonly<{
  outcome: "changes" | "no_changes";
  entities?: readonly EntityMemoryDraft[];
  assertions?: readonly AssertionMemoryDraft[];
  occurrences?: readonly OccurrenceMemoryDraft[];
  intents?: readonly IntentMemoryDraft[];
  inquiries?: readonly InquiryMemoryDraft[];
  procedures?: readonly ProcedureMemoryDraft[];
  relations?: readonly MemoryRelationDraft[];
  lifecycle?: readonly MemoryLifecycleDraft[];
}>;

type MemoryDraftBase = Readonly<{
  localId: string;
  kind: string;
  summary: string;
  spaceId?: string;
  sources: readonly MemorySourceRef[];
}>;
```

`outcome` is required. An intentional empty decision is represented as:

```ts
consolidate_memory({ outcome: "no_changes" });
```

This confirms that the agent reviewed the source range and allows the checkpoint
to advance. Missing the tool call is not treated as an empty consolidation.

Form-specific drafts add the following information:

```ts
type EntityMemoryDraft =
  & MemoryDraftBase
  & Readonly<{
    name: string;
    aliases?: readonly string[];
    externalIds?: Readonly<Record<string, string>>;
  }>;

type AssertionMemoryDraft =
  & MemoryDraftBase
  & Readonly<{
    subject: ProposedMemoryRef;
    predicate: string;
    object:
      | Readonly<{ ref: ProposedMemoryRef }>
      | Readonly<{ value: string | number | boolean | null }>;
    epistemic: MemoryEpistemic;
    temporal?: Readonly<{ validFrom?: string; validTo?: string }>;
  }>;

type OccurrenceMemoryDraft =
  & MemoryDraftBase
  & Readonly<{
    participants?: readonly ProposedMemoryRef[];
    temporal?: Readonly<{ startedAt?: string; endedAt?: string }>;
  }>;

type IntentMemoryDraft =
  & MemoryDraftBase
  & Readonly<{
    owner?: ProposedMemoryRef;
    status: "proposed" | "active" | "completed" | "cancelled";
    target?: ProposedMemoryRef;
    dueAt?: string;
  }>;

type InquiryMemoryDraft =
  & MemoryDraftBase
  & Readonly<{
    question: string;
    status: "open" | "answered" | "obsolete";
    about?: readonly ProposedMemoryRef[];
    answer?: ProposedMemoryRef;
  }>;

type ProcedureMemoryDraft =
  & MemoryDraftBase
  & Readonly<{
    trigger?: string;
    preconditions?: readonly string[];
    steps: readonly string[];
    expectedOutcome?: string;
    applicability?: string;
  }>;
```

Relations use the stable kernel and may connect proposed records, visible
existing memories, and scoped domain nodes.

```ts
type MemoryRelationDraft = Readonly<{
  from: ProposedMemoryRef;
  type:
    | "about"
    | "same_as"
    | "supports"
    | "contradicts"
    | "depends_on"
    | "contributes_to"
    | "blocks"
    | "answers";
  to: ProposedMemoryRef;
  sources?: readonly MemorySourceRef[];
}>;
```

`derived_from` and `supersedes` remain part of the persisted relation kernel,
but the tool does not propose them as unconstrained relations. Copilotz derives
them from validated provenance and lifecycle declarations.

Lifecycle changes are declarative desired states. They may target a visible
memory ID or describe a semantic match for post-call retrieval:

```ts
type MemoryLifecycleDraft = Readonly<{
  target:
    | Readonly<{ memoryId: string }>
    | Readonly<{
      match: {
        form: MemoryForm;
        kind?: string;
        subject?: ProposedMemoryRef;
        predicate?: string;
        query: string;
      };
    }>;
  status:
    | "superseded"
    | "retracted"
    | "completed"
    | "cancelled"
    | "answered"
    | "obsolete"
    | "deprecated";
  replacement?: ProposedMemoryRef;
  sources: readonly MemorySourceRef[];
}>;
```

If semantic target resolution is ambiguous, Copilotz does not mutate the old
record. It may retain the new record and contradiction while reporting an
unresolved reconciliation internally.

### Agent prompt and instructions

The memory attempt reuses the canonical agent prompt builder, agent identity,
resolved instructions, provider/model policy, previous memory contribution, and
reserved canonical transcript. It does not use a synthetic independent
consolidator identity. Only the reserved range is eligible as conversational
evidence, although frozen application evidence may also be supplied by context
resources.

The maintenance request is a system instruction, never a fake user message. Its
normative behavior is:

```text
## Internal memory maintenance

Copilotz reserved part of your conversation history for durable memory
consolidation. This is internal maintenance, not a new user request.

Review the reserved history using your normal identity and instructions. Call
consolidate_memory exactly once. If nothing durable changed, call it with
{"outcome":"no_changes"}. Do not answer the user or continue the task.

Extract only durable entities, assertions, meaningful occurrences, active
intents, unresolved inquiries, and reusable procedures. Every record must be
self-contained and cite allowed sources. Preserve uncertainty, negation,
temporal meaning, authorship, and explicit corrections. Do not turn tentative
language into facts, silently overwrite conflicts, create an entity for every
noun, or persist small talk, raw tool output, token deltas, and transient
wording. Use the default writable memory space unless another listed writable
space clearly owns the record.
```

The prompt then appends the allowed source catalog, writable spaces, registered
forms/kinds, previous active memory, and frozen application context. Kind
definitions are generated from the registry rather than duplicated in prompt
code.

### Durable execution and reconciliation

The target lifecycle is:

```text
token threshold reached
        |
reserve source range and pending checkpoint
        |
capture and persist application-context snapshot
        |
create internal LLM attempt for the same agent
        |
ordinary provider invocation with automatic tool selection
        |
one valid consolidate_memory call
        |
ordinary durable tool validation and execution
        |
retrieve candidates per proposed record
        |
resolve identities, duplicates, changes, and conflicts
        |
atomic semantic graph and checkpoint commit
        |
advance history cutover and refresh derived continuity
```

Retrieval happens after semantic extraction and is performed independently for
each proposed record. Copilotz looks for entity candidates, assertions with the
same subject/predicate and overlapping validity, and related active intents,
inquiries, and procedures. It never uses the whole raw transcript joined into
one pre-consolidation similarity query.

Reconciliation is conservative:

- duplicates gain provenance without duplicating semantic meaning;
- explicit changes create a new record and supersede or close the old one;
- contradictions preserve both records and connect them;
- ambiguous entities remain separate until safely resolved; and
- inferred records retain their derivation chain.

The checkpoint and tool-execution IDs are idempotency keys. A successful tool
call returns only an internal count summary and produces no public message, tool
status, or same-agent conversational continuation.

If the agent emits no tool call, Copilotz publishes no text and creates one
bounded internal repair attempt. Invalid arguments use ordinary tool validation
and an internal same-agent correction. Multiple consolidation calls for one
checkpoint are rejected before mutation. Exhausted repair or delivery attempts
fail the checkpoint and leave the history cutover unchanged.

The current direct path using `runChat`, `tools: []`, JSON response mode, and
assistant-answer parsing is removed after the native tool workflow is active.

## Plugin context and application evidence

### General context resource

Applications customize information sent to agents through an ordinary
plugin-level `context` resource rather than a memory-plugin callback:

```ts
type ContextPurpose = "conversation" | "memory_consolidation";

type ContextContributionInput = Readonly<{
  purpose: ContextPurpose;
  agent: Agent;
  participant: Participant;
  thread: ConversationThread;
  sourceRange?: Readonly<{
    startMessageId: string;
    endMessageId: string;
    messages: readonly ConversationMessage[];
  }>;
  collections: Readonly<Record<string, ScopedEventCollection>>;
  signal: AbortSignal;
  idempotencyKey: string;
}>;

type ContextResource = Readonly<{
  id: string;
  type: "context";
  purposes: readonly ContextPurpose[];
  contribute(
    input: ContextContributionInput,
  ):
    | ContextContribution
    | readonly ContextContribution[]
    | null
    | Promise<ContextContribution | readonly ContextContribution[] | null>;
}>;
```

Resources are plain plugin data:

```ts
definePlugin({
  manifest: {
    id: "@example/workspace",
    version: "1.0.0",
    provides: { context: ["example.workspace"] },
  },
  resources: { context: [workspaceContext] },
});
```

The contribution input includes purpose, agent, participant, thread, scoped
collections, cancellation signal, idempotency key, and, for consolidation, the
reserved source range. A resource may return `null` and may vary its bounded
representation by purpose or agent.

### Context and evidence roles

```ts
type ContextContribution = Readonly<{
  id: string;
  title: string;
  role: "context" | "evidence";
  content: ContentInput | ContentRef;
  source?: MemorySourceRef;
  capturedAt?: string;
}>;
```

`context` helps interpret the reserved conversation but cannot be the sole
source of a memory. `evidence` is an authoritative, versioned source that the
agent may cite directly. Evidence contributions require a source reference.

Contributed content is always rendered as untrusted application data, never as
instructions. User-authored shared documents cannot override the maintenance
system instruction.

Only the long-term-memory contribution may set the transcript cutover boundary.
General application context cannot hide conversation history. The current
prompt-memory contribution mechanism should therefore be generalized into the
context registry instead of being overloaded with application state.

### Frozen snapshots and retries

"Latest" means the latest version captured when the consolidation attempt began.
Copilotz:

1. reserves the source range and checkpoint;
2. collects applicable context contributions;
3. prepares content through the canonical content/asset layer;
4. persists prepared content references, source versions, hashes, and capture
   times on the checkpoint;
5. reuses that exact snapshot for provider and delivery retries; and
6. admits only those frozen source references to `consolidate_memory`.

The snapshot is persisted before the provider call. If context capture fails,
the durable delivery retries without advancing the cutover. No additional table
is required when checkpoint metadata and asset-backed content references are
sufficient.

This snapshot rule also applies across application recovery. A rebuilt Copilotz
generation resumes the pending consolidation from its persisted context snapshot
instead of re-reading a newer application state.

### Compass application

Compass should contribute its versioned thread-scoped `sharedDocument` and
`kanbanBoard` collection records through one `compass.workspace` context
resource. A shared document may be sent in full within a bounded budget or as an
asset-backed extract. Kanban contribution should normally be compact and include
card IDs, titles, descriptions, stages, owners, update times, board version, and
update time rather than every historical comment.

Both collections remain canonical application state. Semantic memory does not
become a second document store or kanban database. Memory captures durable
meaning such as decisions, ownership, blockers, goals, and learned procedures,
with provenance back to an exact document version, board version, or card
fragment. Agents continue to query the canonical collection when exact current
state is required.

An application may expose the same context resource to ordinary conversation
with `purposes: ["conversation", "memory_consolidation"]` and return a smaller
representation for conversation. The mechanism is also suitable for future
realtime prompt composition without another application-specific contract.

## Memory querying

Agent and user queries share the same semantic graph and access rules. The
ontology must support at least:

- current knowledge about an entity;
- source and attribution explanations;
- temporal state and knowledge-history queries;
- active decisions, objectives, actions, and open inquiries;
- conflicts, corrections, and superseded records;
- prior procedures and environment lessons; and
- correction, retraction, forgetting, and source inspection.

Retrieval combines space/access filtering, form and kind facets, entity and
predicate matching, valid and transaction time, semantic and lexical search,
graph traversal, source authority, relevance, recency, and salience. Embeddings,
access counters, ranking weights, and cached views are replaceable retrieval
infrastructure rather than ontology.

## Memory implementation and cleanup sequence

1. Introduce memory forms, kind definitions, source references, temporal and
   epistemic facets, and form-specific lifecycle schemas in isolated modules.
2. Introduce general context resources and frozen checkpoint snapshots.
3. Implement the native `consolidate_memory` tool and internal memory-attempt
   projection over the existing durable LLM/tool workflow.
4. Move candidate retrieval after tool extraction and implement conservative,
   idempotent reconciliation.
5. Persist semantic records and relations atomically with successful checkpoint
   settlement, then derive continuity and advance the cutover.
6. Add agent/user memory query, explanation, timeline, correction, and lifecycle
   operations over the same graph.
7. Migrate current memory records and remove the mixed kind/layer model,
   duplicated continuity persistence, whole-range pre-retrieval, direct JSON
   consolidator, parser adapters, and obsolete tests and documentation.
8. Add Compass workspace context only after the generic plugin contract is
   tested in Copilotz.

Implementation remains factory/closure based. The refactor must not introduce
classes or a parallel non-event-native runtime path.

## Memory acceptance criteria

- Every semantic memory is traceable to authorized evidence or to other
  traceable derived memories.
- Conflicting, corrected, and temporally changing assertions retain history.
- Continuity is derived from ordinary semantic records without a second
  canonical `continuityPatch` store.
- Consolidation uses the responsible agent's canonical prompt and normal tool
  machinery, with no provider-forced tool choice or direct JSON parser.
- Only `consolidate_memory` is granted during an internal memory attempt, and no
  consolidation output appears in the public conversation.
- An explicit `no_changes` call settles an empty checkpoint; a missing or
  invalid call does not advance the cutover.
- Candidate retrieval is driven by proposed semantic records after extraction,
  not by one joined raw-history query before extraction.
- Duplicate execution and generation recovery cannot duplicate memory records or
  observe a different context snapshot.
- Context-only contributions cannot become sole evidence; evidence contributions
  cite an exact authorized source version.
- General context resources cannot alter transcript cutover boundaries.
- Compass shared-document and kanban state remain canonical in their collections
  rather than being copied wholesale into memory.
- Agent and user querying can explain what Copilotz remembers, why, from whom,
  during which period, and whether the record is current, disputed, or
  superseded.
