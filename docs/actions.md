---
title: "Actions"
description: "Define validated, recorded operations with defineAction, call them through typed context.actions callers, and keep repeated calls and external effects safe with operation keys."
section: Runtime
order: 30
status: stable
---

# Actions

## The pain

A Notes application saves a note from a Processor today. Tomorrow an HTTP route,
a schedule and an agent tool need the same save. If each caller copies the
write, each copy drifts: one forgets to reject empty text, one retries and
stores a duplicate, and nobody can tell afterwards which call accepted which
input or what it returned.

## The problem

Shared behaviour needs one owner with a contract that holds for every caller:

- input is checked before the operation runs and before its invocation is
  recorded;
- each call is recorded as a unit, with its input, progress and outcome;
- a call that is repeated after a retry or crash resolves to the same outcome
  instead of doing the work twice;
- sensitive input is kept out of the public record of the call.

## The solution

`defineAction` declares a named operation. An Action never subscribes to Events
and never runs on its own; a trusted host, Processor, another Action, tool or
exposed route calls it through the runtime, which validates the input, records
the call and runs `execute`.

### A complete Action

`save-note.ts` is a pure definition module: no environment reads and no
top-level I/O. It needs only `@copilotz/copilotz@^0.87.3`. It declares the
`note` Collection it writes, so the file stands alone.

```ts
// Action and Collection helpers.
import { defineAction, defineCollection } from "@copilotz/copilotz";
// The context every Action receives.
import type { ActionContext } from "@copilotz/copilotz";

// Stored notes. The Collection validates every record before it is stored.
export const note = defineCollection({
  name: "note",
  schema: {
    type: "object",
    properties: {
      id: { type: "string", readOnly: true },
      text: { type: "string" },
    },
    required: ["text"],
  } as const,
});

// Input that callers pass; `inputSchema` enforces the same shape at run time.
export type SaveNoteInput = { text: string };

// Validated, recorded operation that stores one note.
export const saveNote = defineAction({
  // Stable identity. Lifecycle Event types derive from it
  // (`notes.save.invoked`, `notes.save.completed`, ...), so keep it once stored.
  id: "notes.save",
  // Checked before `execute` and before `notes.save.invoked` is recorded.
  // Invalid input records no `notes.save.*` Event.
  inputSchema: {
    type: "object",
    properties: { text: { type: "string", minLength: 1 } },
    required: ["text"],
    additionalProperties: false,
  } as const,
  // Checked after `execute` returns and before the completed Event is written,
  // so a caller never receives an output that breaks this contract.
  outputSchema: {
    type: "object",
    properties: { id: { type: "string" }, text: { type: "string" } },
    required: ["id", "text"],
  } as const,
  async execute(input: SaveNoteInput, context: ActionContext) {
    // Persist one self-contained `notes.save.progress` Event.
    await context.progress({ stage: "storing" });
    // Collection keys are scoped to the running delivery, not to this call.
    // Prefixing with this call's stable identity keeps two calls in one
    // delivery apart, while a retry of this call finds its stored note.
    return context.collections.note.create(
      { text: input.text },
      { operationKey: `${context.operationKey}:save-note` },
    );
  },
});
```

`defineAction` checks the definition when the module loads. An unknown property,
an invalid `id`, a missing `execute`, a non-object schema or an invalid
`content` declaration throws a `TypeError`. The schemas are snapshotted, so
later changes to the objects you passed in have no effect. The returned
definition has a readonly TypeScript type but is not frozen at run time.
Register it under an alias in `createCopilotz({ actions: { saveNote } })` or in
a plugin's `actions` map. Callers use the alias (`saveNote`); the records use
the `id` (`notes.save`).

### Call from a host

`app.actions.saveNote({ text }, options)` starts a new recorded operation and
returns the Action output after inherited work settles. The alias is `saveNote`;
the durable Events still use `notes.save.invoked` and `notes.save.completed` (or
`failed`/`cancelled`). Invalid input is rejected before those Events exist. An
identical `idempotencyKey` restores the recorded output or failure without
executing the Action again.

Inside an Action or Processor,
`context.actions.saveNote(input, { operationKey })` runs within the current
delivery and operation. The host call uses `idempotencyKey` because it admits
its own operation. `app.actions` is an enumerable map of the same caller-facing
aliases, with composed input and output types; internal ingress Actions are
excluded.

Create `run-note.ts` as an **entrypoint**, alongside the `save-note.ts`
definition above. It takes note text from the command line and needs no Server
plugin, Processor or HTTP listener:

```ts
import { argv } from "node:process";
import { createCopilotz } from "@copilotz/copilotz";
import { note, saveNote } from "./save-note.ts";

// Host composition selects the namespace and registers the reusable definitions.
const app = await createCopilotz({
  namespace: "notes-admin",
  collections: { note },
  actions: { saveNote },
});
try {
  // Input comes from the host. Reuse a key only for the same intended call.
  const text = argv.slice(2).join(" ");
  if (!text) throw new Error("Pass note text as a command-line argument.");
  const result = await app.actions.saveNote({ text }, {
    idempotencyKey: "admin-note-1",
    actionMetadata: { origin: "admin-script" },
  });
  console.log("Saved:", result);
} finally {
  // Also release the application after a validation or execution failure.
  await app.close();
}
```

Run `deno run -A run-note.ts "Review the draft"` or
`node run-note.ts "Review the draft"`. Expect `Saved:` and the stored note. The
default database is private and in-memory; durable retries across process
restarts require the same persistent database. Inside the Action,
`context.action.metadata.origin` is `"admin-script"`. As with HTTP route
invocation, the runtime adds reserved `copilotzServer` ingress provenance;
caller metadata is otherwise preserved and is not inherited by nested Actions.

Prefer this API for scripts and tests that name a capability directly. Prefer
`app.send` plus a Processor for Event-driven orchestration and admission
handles. See [Trusted host calls](api.md#trusted-host-calls) for scoping, return
types and Gateway/Worker behavior.

### Caller-safe errors

Throw `ActionError` when an Action deliberately refuses a request and its
message is safe for a person using the HTTP API. It is exported from
`@copilotz/copilotz` and `@copilotz/copilotz/actions`. Supply a non-empty
message and `code`; `status` defaults to `422` and must be an integer from `400`
to `499`. Setting `code` or `status` on an ordinary Error does not make it
caller-safe.

For example, `board-errors.ts` is a pure helper module that a board Action can
import when its Collection lookup finds that a card belongs to another board:

```ts
// Public error type shared by Action authors and HTTP result recovery.
import { ActionError } from "@copilotz/copilotz/actions";

// Refuse the operation with a message the application permits callers to see.
export function cardNotOnBoard(cardId: string): never {
  throw new ActionError(`Card '${cardId}' is not on this board.`, {
    code: "card_not_on_board",
    status: 409,
  });
}
```

HTTP route handlers' `context.invoke` rejects with that message and code. The
generic Action result endpoint returns `{ error: { code, message } }` with the
chosen 4xx status. These fields survive recorded replay. Unknown Action errors
remain `action_failed` / `Action execution failed.` over HTTP. Trusted
`app.actions` calls receive the recorded name, message and optional string code
of ordinary errors as well. Restored errors do not promise the original custom
subclass or stack.

An Action with secret-marked input or output keeps its bounded, generic recorded
error, even when it throws `ActionError`. Never put credentials in caller-safe
messages or codes. This helper controls disclosure, not delivery retry policy;
use `markNonRetryable` separately where that policy is needed.

### Lifecycle

Each accepted call appends these Events to the caller's operation, so the
caller's `done` waits for them:

| Event            | Data                                                                        |
| ---------------- | --------------------------------------------------------------------------- |
| `<id>.invoked`   | `actionRunId`, `actionId`, `metadata`, `input`                              |
| `<id>.awaiting`  | the same, plus durable `handoff` and child `start`; the Action remains open |
| `<id>.progress`  | the same, plus `progressIndex` and `progress` (zero or more)                |
| `<id>.completed` | the same, plus `output`                                                     |
| `<id>.failed`    | the same, plus `error: { name, message, code? }`                            |
| `<id>.cancelled` | as `failed`, when the call's signal aborts                                  |

The types `ActionInvokedData`, `ActionProgressData`, `ActionCompletedData` and
`ActionFailedData` describe these payloads. Caller-safe errors also record
`callerSafe: true` and their 4xx `status`; older errors without those fields
remain valid. Rules worth knowing:

- **Invalid input is rejected before the lifecycle.** The call throws a
  non-retryable error, `execute` does not run, and no `<id>.*` Event is written.
  Anything recorded earlier stays recorded, including the generic input that
  `app.send` already admitted and stored. A failing schema check does not erase
  it.
- **Output validation does not roll back work.** An output that fails
  `outputSchema` fails the call instead of completing it, but a Collection write
  or external effect that `execute` already committed stays committed. An Action
  is not one database transaction; use `context.transaction` when several writes
  must commit together.
- **Terminal outcomes are final for their invocation identity.** Once an
  invocation has a `completed`, `failed` or `cancelled` Event, the same
  invocation restores that outcome when it runs again: the recorded output, or
  the recorded error. `execute` does not run again. A crash before the terminal
  Event is written can run `execute` again under the same identity, which is why
  writes and effects inside it need their own keys. How the identity is formed
  is described under [Invocation identity](#invocation-identity).
- **Delivery retries are separate.** Whether a failed Processor delivery is
  retried is the delivery's retry policy, not the Action's. Wrap an error with
  `markNonRetryable` (exported from `@copilotz/copilotz` and
  `@copilotz/copilotz/plugins`) when retrying cannot help. Trying the work again
  after a recorded failure needs a new invocation. A later ordinary call in the
  same handler already is one; a prepared or nested retry needs a new explicit
  key.
- **Exhausted deliveries settle their open Actions.** Permanent failure or the
  final expired lease records a failed terminal and its consumer deliveries in
  the same transaction. The operation remains open until those continuations
  drain. A worker whose lease was lost cannot publish a late terminal.

### Awaiting an operation

An Action may wait for a child it owns or observe an existing operation. Return
`context.awaitOperation({ operationId, handoff })` to observe a shared producer:
registration rejects unknown IDs, does not change ownership, and cancellation of
one waiter leaves the producer and other waiters running. A single settlement
resumes every live waiter, each with its own `${runId}:resume` identity. An
already settled producer resumes immediately. Both forms reject self, ancestor,
and transitive wait cycles. A cancelled producer supplies a `cancelled` outcome.

When a domain needs shared work,
`await context.operations.start({ action, input,
operationKey })` admits an
independent public operation and returns its ID. The key is scoped to the
namespace, retries must describe the same invocation, and admission returns
after the operation and its delivery are durable. It does not wait for execution
or create a parent link. Observe the returned ID with
`awaitOperation({ operationId, handoff })`.

Return `context.awaitOperation({ start, handoff })` from `execute`, and declare
`resume(handoff, outcome, context)`. `start` names a registered Action alias and
its input. `handoff` is durable JSON used by the resumption.

```ts
import { defineAction } from "@copilotz/copilotz/actions";

export const buildReport = defineAction<{ reportId: string }, string>({
  id: "reports.build",
  execute(input, context) {
    return context.awaitOperation({
      start: { action: "prepareReport", input },
      handoff: { reportId: input.reportId },
    });
  },
  async resume(handoff, outcome, context) {
    if (outcome.status !== "completed") {
      throw new Error("Report preparation failed.");
    }
    const { reportId } = handoff as { reportId: string };
    const report = await context.collections.report.get({ id: reportId });
    if (!report || typeof report.url !== "string") {
      throw new Error("Report is unavailable.");
    }
    return report.url;
  },
});
```

The runtime atomically records the awaiting obligation and starts a separate
public operation with `parent: { operationId, actionRunId }` and inherited
observation keys. The caller receives `{ status: "awaiting", actionRunId }`, and
the execution slot becomes available. Child deliveries, Actions, and streams
settle independently of the parent's open obligation.

Child settlement schedules one logical `${runId}:resume` delivery. Its terminal
receipt arbitrates duplicates and survives restart. An already-settled child
schedules the resumption at registration. `start.operationId` may supply a
stable child identity; it must belong to that same Action invocation. A child
cannot be acquired from another invocation or shared by two `start` awaits.

`outcome` contains the child `operationId` and its `status`: `completed`,
`failed`, or `cancelled`. The resumption decides its own result from durable
domain data; a completed operation does not certify a successful answer. The
original Action identity and metadata remain available in `context.action`. A
resumption must produce a terminal result.

Cancellation closes the parent's obligations and cancels linked children. A
cancelled child resumes its waiting parent with `cancelled`. Self and ancestor
waits are rejected. Detached starting Processors still do not hold the
foreground operation open; their declared children are independently observable
operations.

Awaiting requires a durable delivery. Direct host executions cannot own durable
continuations. Plugins decide what results mean; the runtime only owns
admission, execution authority, settlement, and resumption.

### Typing callers

The runtime always passes every registered caller in `context.actions`. To
type-check calls, declare the callers you expect with `ActionCallers` as the
**third** type parameter of the context. This is a TypeScript declaration, not a
permission: nothing is granted or hidden.

`action-contexts.ts` holds type declarations only:

```ts
// Context and caller types.
import type {
  ActionCallers,
  ActionContext,
  ProcessorContext,
} from "@copilotz/copilotz";
// Type-only import: the caller types derive from the definition.
import type { saveNote } from "./save-note.ts";

// Processor context whose `actions.saveNote` is typed from the definition.
export type CaptureContext = ProcessorContext<
  ProcessorContext["resources"],
  ProcessorContext["adapters"],
  ActionCallers<{ saveNote: typeof saveNote }>
>;

// The same declaration for an Action that calls another Action.
export type ImportContext = ActionContext<
  ActionContext["resources"],
  ActionContext["adapters"],
  ActionCallers<{ saveNote: typeof saveNote }>
>;
```

Call options for `context.actions.<alias>(input, options)`:

- `operationKey` labels the call inside its invocation identity (see below). Use
  a descriptive key such as `save-request`, and never reuse an identity for a
  different input.
- `metadata` is caller-owned JSON recorded on every lifecycle Event and visible
  as `context.action.metadata`.
- `identity` and `signal` carry correlation and cancellation.

### Invocation identity

The runtime identifies each call from where it happens, not from the key alone.
An operation key by itself is not an application-wide deduplication ID:

| Call                                                | Identity                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------- |
| `context.actions.x(input, opts)` in a Processor     | delivery + call position in the handler + Action ID + optional key  |
| `context.actions.x.prepare(f, opts)` in a Processor | delivery + Action ID + required key (no position)                   |
| `context.actions.x(input, opts)` in an Action       | parent Action run + Action ID + key, or call position without a key |

What this means for authors:

- **Ordinary Processor calls follow control flow.** When a delivery is retried,
  the handler runs again and its first call replays the first recorded
  invocation, its second call the second, and so on. Two successive calls in one
  attempt are two invocations, even with the same key, so each saves its own
  note. Keep the handler's call order stable across retries: compute the input
  deterministically from the Event and call in a fixed order.
- **`prepare` captures by key.** Repeated preparations of the same Action with
  the same key in one delivery identify one captured call, wherever they occur.
  Use it when the input is selected at call time and the call should not depend
  on its position.
- **Same identity, same input.** An ordinary invocation that replays with
  different input is rejected. A prepared invocation instead restores the input
  it captured and does not compare it with freshly selected data.

### Deferred input with `prepare`

Sometimes the input is built at call time, for example from a snapshot read.
`caller.prepare(factory, { operationKey })` captures the factory's
`{ input, metadata? }` under a required key. `capture-note.ts` is a complete
pure Processor module that uses it with the two files above:

```ts
// Processor helper.
import { defineProcessor } from "@copilotz/copilotz";
// The typed context declared in action-contexts.ts.
import type { CaptureContext } from "./action-contexts.ts";
// Input type of the `notes.save` Action.
import type { SaveNoteInput } from "./save-note.ts";

// Saves one note for every stored capture request.
export const captureNote = defineProcessor<CaptureContext>({
  id: "notes.capture",
  on: [{ eventType: "notes.capture.requested" }],
  async handle(event, context) {
    // Only stored requests, so each note traces back to a recorded Event.
    if (!event.durable) return;
    await context.actions.saveNote.prepare(
      // Read-only: builds the input from the request's resolved data. The
      // Action's input schema still validates it.
      () => ({ input: event.data as SaveNoteInput }),
      // Names this call within the delivery; required for `prepare`.
      { operationKey: "save-request" },
    );
  },
});
```

If a receipt for that Action and key already exists in the delivery (invoked or
terminal), it is restored before the factory runs, so a retry reuses the
captured input rather than recomputing it. This is not exactly-once execution of
the factory: a crash before the receipt commits, or two concurrent first
preparations, can evaluate it again. Keep the factory read-only and free of side
effects.

### Scoping writes and external effects

- **Direct Collection writes** inside `execute` stay scoped to the running
  delivery. Prefix their keys with `context.operationKey`, as `saveNote` does.
- **`context.content.prepare`** keys are prefixed with the Action call
  automatically; pass a short local key.
- **External effects** (email, payments, third-party APIs) are outside the
  runtime's records. Give each one the provider's own idempotency key, derived
  from `context.operationKey`, so a re-run `execute` cannot repeat the effect.

### Content declarations

`content: { input: ["attachments[]", "body"], byteLimit? }` names up to 32 input
paths (dotted fields, `[]` for arrays) that hold content. Before the input
schema is checked, the runtime normalizes the values at those paths: it prepares
new content, which can publish Assets, and hydrates references so `execute`
receives the resolved shape. The durable lifecycle Events store references, not
inline bodies. An aggregate byte budget applies per call (32 MiB by default).
Only declared paths are interpreted.

Content declarations govern Action **input**; Action output has no content
declaration. `context.content.prepare` returns prepared content whose byte
bodies are not yet durable, so never return it directly as JSON output. To
produce large content, prepare bounded content inside the Action, adopt it
through a declared content field of a Collection, and return the stored record,
which carries canonical content references. See
[Content and Assets](content-assets.md) for the details. Content declarations
cannot yet be combined with secret schemas.

### Secret fields

Mark a schema property with `"x-copilotz-secret": true` in `inputSchema` or
`outputSchema`. Public lifecycle data then holds placeholders instead of those
values, and the runtime stores them separately as sealed protected values.
Actions with secret-marked input or output record bounded, generic errors
without application messages or codes. Metadata that contains a protected input
value is rejected. That check compares against the protected values only; it
does not detect secrets in general, so keep secrets out of metadata yourself.
Secret Actions cannot record `progress`.

An application with secret Actions must configure `adapters.secrets.default`
with a Secret Adapter that the host provides. Its `seal` and `open` methods must
perform genuine authenticated encryption with a key the host manages, binding
the `additionalAuthenticatedData` they receive. `seal` returns the ciphertext, a
deterministic keyed `commitment` that reveals nothing about the plaintext, and a
secret-free `envelope` (key, version and nonce metadata) that `open` needs.
`createSecretAdapter` validates the adapter object; it does not provide this
cryptography.

The protection covers the schema-aware Action lifecycle only. A secret sent in a
plain `app.send` payload is stored as ordinary Event data before any Action sees
it, and nothing erases it afterwards. Accept secrets through a schema-aware
entry, such as an Action exposed over HTTP by `serverPlugin`, whose route
validates input against the Action's schema, rather than through generic Events
or a custom route that forwards them to `app.send`.

## What this unlocks

- One validated, inspectable operation shared by Processors, other Actions,
  tools and HTTP routes.
- Safe repeats: a replayed invocation resolves to its recorded outcome, and
  scoped keys keep writes and external effects single.
- Clear failure handling, with typed lifecycle data for observers and tests.

## Next steps

- Tutorial:
  [Chapter 4: Share Operations as Actions](getting-started/part-1-design-and-build/04-share-operations-as-actions.md)
  builds `notes.save` step by step.
- Reference: [Collections](collections.md) covers the writes an Action makes.
- Reference: [Events, Deliveries, and Recovery](events-deliveries-recovery.md)
  explains delivery scopes, retries and operation keys.
- Reference: [Content and Assets](content-assets.md) covers content preparation
  and references.

## External effects and recovery

Mutating external calls use `context.effect` inside an Action. `begin(step)` is
keyed by the durable Action run and a bounded step name. Only `proceed` permits
a new dispatch. `replay` carries a confirmed JSON outcome and must not dispatch.
After dispatch, `confirm(step, safeOutcome)` records a bounded, non-secret
result or reference. `externalEffect(context, step, callback)` performs this
pattern for JSON-result operations.

Protected outputs are stored through the Action lifecycle. Effect confirmation
accepts only bounded, non-secret results or references. A lost confirmation
reply must be recovered from retained effect state, never by repeating the
provider call.

A committed `begin` whose reply was lost does not grant dispatch permission. An
interrupted begun effect invokes the Action's optional
`reconcile(step,
context)` hook before ordinary execution resumes. Without a
known outcome it fails with `effect_indeterminate`. Provider exceptions,
timeouts and cancellation are not proof that the operation did not happen.
Reconciliation may confirm a known result, or close the step with `notStarted`
only when the owner can verify trusted no-start evidence. A subsequent dispatch
requires a different step name. The built-in provider adapters do not invent
such evidence.

Recovery checks each Action's retained effect steps, including steps removed by
a newer deployment. Old attempts without the original replay contract cannot
acquire it retroactively. Swallowing an effect error does not permit a
successful Action terminal.

Built-in channel delivery, command execution, file mutation, mutating HTTP and
unknown MCP calls use this protocol. Read-only filesystem tools, HTTP
GET/HEAD/OPTIONS and terminal inspection/export keep ordinary retry behavior.
For MCP, declare host-reviewed tool names in `readOnlyTools`; provider
annotations alone do not establish read-only safety. Do not classify a mutating
operation as read-only merely because its provider supports idempotency.

### Owner-local protected preparation

For declared secret Actions, an embedded host or Gateway may register local
`protectedActions` keyed by the stable Action ID. Declare required phases on the
Action as `ownerHooks: { prepareInput: true }`; startup refuses missing
registrations or phases. Ordinary secret Actions need no hooks. Worker
configuration refuses callbacks, and Workers have no hook RPC.

Each registration supplies:

- `authorize(input, context)`: required, read-only current-domain authorization
  on preparation, replay, effect commands, completion and protected result
  recovery.
- `prepareInput(input, context)`: required first-capture preparation. Return the
  complete input. Only declared secret slots and explicit `publicRevisionFields`
  may change; all other public fields must remain identical.
  `publicRevisionFields` contains exact, non-overlapping JSON Pointers to
  explicit public string/number/null revision properties, such as
  `/credentialRevision`. Ownership and identity coordinates cannot be selected.
  Keep owner-filled fields optional in the admitted input schema; the completed
  prepared input is fully validated. Retries authorize again and reuse the exact
  first input capture.

A sealed object may contain public coordinates alongside credentials. Mark each
explicit public scalar property with `"x-copilotz-secret": false` for metadata
leak analysis only. The enclosing secret object remains fully encrypted and
redacted; this does not permit preparation to change other public input fields.
Object and array containers cannot opt out. Only unambiguous typed object
properties, including properties in homogeneous arrays of typed objects, support
this annotation. Nullable properties use a `type` array; references, unions,
conditionals, pattern properties and tuple paths are refused. A validated scalar
marker outside a secret aggregate is a no-op, allowing schema reuse. Undeclared
leaves stay confidential, and a token remains protected even when its bytes
equal a separately annotated public coordinate.

The `ProtectedActionOwnerContext<Input>` type is exported from `/actions`,
`/application`, and the package root. It exposes only a revocable `query`
handle, fixed `scope.databaseSchema` and `scope.namespace`, the current
validated `action.id`, `action.runId` and optional `action.parentRunId`,
immutable captured `input`, `commandTime`, and `signal`. `resolveSource()`
resolves the retained original event/body and root-first operation ancestry,
including protected source data. It accepts no caller-selected event, record,
schema, run or capture reference. All handles expire when the callback finishes,
throws or is cancelled, including before a synchronous callback's queued
microtask can use them.

Source `ingress` is owner-created evidence bound atomically to the exact
retained event/body, never a metadata flag:

- `host` proves in-process host admission, not an end-user identity.
- `authenticated-server` includes the server-owned actor after configured
  authentication and authorization hooks both succeed.
- `server-route` includes an exact custom HTTP `routeId`, only for an explicitly
  configured `defineServerFacade({ protectedBootstrapRoutes: [...] })` route
  with both policy hooks. It proves the selected bootstrap route, not a user.
  Unmatched IDs, generic Action endpoints and missing policy hooks are rejected
  at facade setup; ordinary anonymous HTTP has no authenticated provenance.

The first admission classification is immutable. An exact retry of an
unclassified event remains unclassified even from a trusted host; it cannot
create or upgrade provenance. Classified retries must retain their original
class, actor and route. Changed payloads or metadata conflict. Protected policy
still refuses an unclassified original when its required authority is absent.

Policy must validate the original root Action and purpose, re-resolve current
membership and domain state, and refuse unsupported ancestry. Worker metadata,
account selections and identifiers remain claims. Bootstrap policy must verify
its own purpose-bound signed state or ticket before granting domain authority.

Callbacks are local policy/storage phases, never external-network effect phases.
Use the Action's effect protocol for provider work. Unknown COMMIT outcomes
require durable receipt recovery; they never imply rollback. Hook failures
preserve only vetted standardized error codes and fixed public messages;
arbitrary exception details are scrubbed. Secret values stay out of public
Events, effect records and receipt payloads.

Transactional protected captures use durable database staging. For configured
external storage, the existing logical-body promotion protocol uploads only
after confirmed commit and retains the logical identity and database read
fallback. Failed uploads remain tracked by the content catalog. A replay after
an unknown commit can recover the staged value and resume promotion without
repeating the owner preparation.
