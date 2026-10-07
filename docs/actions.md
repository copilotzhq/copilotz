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
and never runs on its own; a Processor, another Action, a tool or an exposed
route calls it through the runtime, which validates the input, records the call
and runs `execute`.

### A complete Action

`save-note.ts` is a pure definition module: no environment reads and no
top-level I/O. It needs only `@copilotz/copilotz@^0.85.4`. It declares the
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

### Lifecycle

Each accepted call appends these Events to the caller's operation, so the
caller's `done` waits for them:

| Event            | Data                                                         |
| ---------------- | ------------------------------------------------------------ |
| `<id>.invoked`   | `actionRunId`, `actionId`, `metadata`, `input`               |
| `<id>.progress`  | the same, plus `progressIndex` and `progress` (zero or more) |
| `<id>.completed` | the same, plus `output`                                      |
| `<id>.failed`    | the same, plus `error: { name, message }`                    |
| `<id>.cancelled` | as `failed`, when the call's signal aborts                   |

The types `ActionInvokedData`, `ActionProgressData`, `ActionCompletedData` and
`ActionFailedData` describe these payloads. Rules worth knowing:

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
values, and the runtime stores them separately as sealed protected values. Known
protected strings are redacted from recorded errors, and metadata that contains
a protected input value is rejected. That check compares against the protected
values only; it does not detect secrets in general, so keep secrets out of
metadata yourself. Secret Actions cannot record `progress`.

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
