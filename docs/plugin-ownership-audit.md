# Plugin ownership and layout

## Ownership rules

- `authoring` contains declaration/composition helpers, including Core’s Agent,
  Context, Prompt Instruction and Tool declarations.
- An Action, Processor, Collection, Resource or Adapter owns its implementation.
  Helpers used by only that primitive stay beside it.
- `shared` contains cohesive execution contracts/algorithms genuinely reused by
  distinct primitive owners. Public export status does not decide placement.
- Tests, re-export barrels and authoring generators do not count as primitive
  consumers. Transitive execution consumers do count, including worker
  entrypoints.

## Core corrections

Core HTTP is an optional generated plugin with four conversation mutation
Actions and one HTTP Adapter. Conversation association criteria stay with the
Adapter; generic operation/event queries run through the runtime catalog API.
Core alone installs no HTTP routes. The browser conversation client and CLI are
Adapters; the client/server history codec is shared. Agent capability resolution
is a static context-resolved Resource. Goal execution is an Action with a policy
Resource and explicit conversation Adapter.

Message Router owns contribution preparation/rendering. Project Text Result owns
initial tool-plan validation and snapshots; Project Tool Result owns terminal
parsing. Common tool-plan execution and its JQ worker remain shared across
processors. Generation identifiers belong to Tool authoring. Duplicated unused
projection functions and dead validation helpers were removed.

Core’s thread metadata accepts only the current public/system envelope. System
namespaces are opaque to Core; Channel ingress owns its channel updates. No
legacy key conversion or unused Memory-specific metadata contract remains.

## Reviewed shared contracts

- Record projections/validation/schema: multiple Core Actions, Collections and
  Processors, plus explicit public consumers.
- Agent grants, transcript preparation and runtime context: conversation/tool
  processors, compact-context and Memory consumers.
- Tool-plan execution, stages and JQ: result projection, coordinator and Ask
  completion/failure paths.
- Workflow metadata: writers and readers share one wire contract; a writer with
  one callsite is not independently treated as a reusable algorithm.
- Context contribution collection/types: Message Router and compaction policy;
  rendering is local to Message Router.
- Event policy and history codec: multiple execution and transport consumers.
- Thread metadata: generic public/system isolation for conversation and channel
  consumers.

## Verification limits

The previous audit counted authoring modules as primitive owners and measured
reuse per file. Its claim that all 71 shared files proved compliant was invalid.
The corrected review considers cohesive functions/contracts and their consumers.
The focused Core check catches hidden authoring instances, missing default
Resource/Adapter instances, audited single-owner helpers in the wrong location,
and reintroduced legacy/foreign metadata policy. It complements semantic review;
it does not claim to prove arbitrary helper ownership automatically.

Generated-source, package-surface and behavior checks remain independent gates.
No plugin `internal`/`dependencies` folders, compatibility wrappers or
production `Object.freeze` calls are introduced.
