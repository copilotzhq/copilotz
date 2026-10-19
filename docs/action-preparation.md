---
title: "Named Action preparation"
description: "Capture authorized record and View projections once, and reauthorize their original provenance on every later use."
section: Runtime
order: 31
status: stable
---

# Named Action preparation

Use `context.actions.<alias>.prepareNamed(request, options)` when a child Action
needs an owner-authorized record rendered through a View. The trusted host
supplies `engine.preparations`; Workers carry only a preparation name, record
ID, mode and explicit operation key.

```ts
await context.actions.send.prepareNamed(
  { preparation: "noteText", recordId: noteId, mode: "channel" },
  { operationKey: "reply" },
);
```

A registration binds `source`, `actionAlias`, `shows`, allowed `modes`, an
explicit `resources` allowlist of `{ namespace, alias }`, and a pure
`mapInput(text, context)`. The callback receives the selected View, rendering
hints and cancellation signal. It must not perform effects: rollback may cause
it to run again. Registrations are captured synchronously from data descriptors,
detached and frozen; accessors are rejected. Callers cannot supply callbacks,
SQL, grants, resource values or parent identities.

## Required owner policy

`ActionPreparations` requires all of these policy boundaries:

- `source.sources`: named `{ collectionAlias, fields, contentPath? }`
  definitions. `fields` are exact, nonoverlapping JSON Pointers. `contentPath`,
  when supplied, must name a declared Collection content field.
- `source.authorize(transaction, context)`: establish the current namespace and
  audience for the fixed source selector.
- `source.projectRecord(record, context)`: produce the authorized safe
  projection from only the registered original fields. Declared secret slots are
  redacted before this callback. Never return protected envelopes or secret
  markers.
- `source.authorizeOriginal(transaction, context)`: authorize the captured
  original record fields and content versions for the current purpose.
- `projectResource(transaction, context)` and
  `authorizeResource(transaction, context)`: project explicitly registered
  resources and authorize their original namespace, alias and captured version.
- `authorizeView(transaction, context)`: authorize the originally selected View
  and hints, including an explicitly captured generic fallback.

Policy contexts contain the owner-resolved Action/run and source binding. Their
`resolveSource()` reads the fixed retained ingress and operation ancestry, with
owner-created ingress classification where available. Caller metadata is not
identity or permission. Transaction/query handles are callback-local and revoked
when the callback ends. Authorization callbacks are read-only owner policy;
runtime mutations and external effects do not belong in them.

Original provenance includes namespace, audience, source name, Collection kind,
record ID, selected fields, record or content selection, projection digest,
content digest and byte length, resource versions, and View selection. A digest
is an integrity/version fact, never permission. Policy must check whether the
caller may still use those original coordinates. Comparing with today's visible
replacement record or resource does not authorize the original data.

## Capture, replay and refusal

The first authorized source projection, resource projection, View rendering,
`mapInput`, input validation and child invocation capture share the existing
owner command transaction. The input lives in the child's invoked Event Body.
Plain content references keep the usual content ownership rules; preparation
adds no Action-owned asset retention.

Concurrent equal requests have one durable winner. Replay returns that input
without rerunning projection, rendering or mapping. Changing the preparation,
record, mode or target under the same parent operation key is a conflict.
Transport incarnation, source/resource changes and renderer implementation are
not semantic identity inputs.

Current authorization runs at duplicate admission, child claim/input, mutation
and result. Retained Action and operation ancestry carries original policy
through `awaitOperation` and `resume`. Missing records, missing original
content, substituted Views, orphan receipts and corrupt provenance fail closed.
Startup checks use the existing Action/Event Body and owner receipt inventory.

Authorization before commit may roll back the current command. A later result
read is a separate disclosure check: refusing a previously committed result does
not undo its mutation. Owner-recognized permanent policy refusal settles an
active Action with sanitized failure and releases its execution obligations. It
cannot be caught and turned into success. A begun external effect retains an
indeterminate outcome, including across an awaited child operation. Unknown
policy or database failures do not become permanent denial merely because their
message resembles one.

Acquired content streams remain native readable streams. Their physical pulls
and retained readers recheck current policy before disclosing bytes, including
`tee`, piping, async iteration and `Response` consumption. Already disclosed
bytes cannot be recalled.

## Bounds and cancellation

Named rendering uses bounded inert snapshots (depth 32, 20,000 nodes), a default
64 KiB byte budget, 16 pending renders and a 1,000 ms deadline. Host settings
`maxBytes`, `maxPendingRenders` and `renderTimeoutMs` are bounded to 1 MiB, 128
and 10,000 ms respectively. Input, resources, rendered text and mapped output
are bounded. A timed-out or cancelled noncooperative View or mapper keeps its
capacity until its actual promise settles. Late input cannot be admitted.

Views receive only the authorized snapshot and registered resources. Named Views
cannot open additional Collection reads or nested Views that would lack captured
provenance. Registered selection and authorized generic fallback remain
available. See [Views](views.md) for the reusable renderer, and
[Actions](actions.md) for callback preparation and durable continuation.
