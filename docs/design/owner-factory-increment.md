# Bounded owner-backed factory increment

Status: experimental ordinary-Action composition. This is a partial application
surface, not completion of the owner, wire, recovery or View contracts.

`createCopilotz` accepts either `storage` or `owner`, with the same plugin
composition and namespace in both placements. The existing embedded/Gateway/
Worker options remain a separate compatibility path. Mixing these paths fails;
there is no automatic fallback from an unavailable owner to legacy persistence.

## Placement and prerequisites

The storage placement requires an explicit SQL session, schema, owner ID, holder
ID, `initialization: "fresh"`, current trusted host policies, and compatible
transport factories. It provisions only an empty single-owner schema. It refuses
restart, takeover and populated-schema activation. The SQL session remains
caller-owned after close or failed startup.

Storage starts a leased embedded worker through the same transport and
owner-backed execution machinery as a connected worker. It does not implement
the distinct F5 owner-local, no-wall-clock execution mode.

The connected placement receives only an opaque owner ID and an explicit worker
connection. The owner address and credentials belong to that connection. It
receives no SQL session or database options. Both placements install the whole
composed plugin registry, including Processors, Resources, Adapters and Views.

The currently published Oxian dependency does not provide the required reverse
calls. A compatible worker factory must be supplied explicitly; storage also
requires a compatible host factory. Selected sibling-source test wiring is
acceptance evidence, not a published dependency upgrade or deployment recipe.

## Same ordinary-Action facade

Given a declared `notesPlugin` and host-supplied storage/worker configuration:

```ts
const embedded = await createCopilotz({
  namespace: "space",
  plugins: [notesPlugin],
  storage, // Explicit fresh storage and current policy, described above
  worker: embeddedWorker, // Explicit compatible factory and connection
});
await embedded.ready;
await embedded.actions.save({ title: "One" }, { idempotencyKey: "save-one" });

const connected = await createCopilotz({
  namespace: "space",
  plugins: [notesPlugin],
  owner: { id: "notes-owner" },
  worker: connectedWorker, // Address, identity and compatible factory
});
await connected.ready;
await connected.actions.save({ title: "Two" }, { idempotencyKey: "save-two" });
```

These overloads return `actions`, `ready`, `closed`, and `close`. They do not
pretend to expose the complete `CopilotzApplication` read, HTTP, observation,
cancellation or maintenance surface. `serverInvoke` is excluded from public
Action callers, as on the existing application facade.

Public `app.actions` uses `idempotencyKey`. Inside an Action or Processor,
`ctx.actions` and `ctx.transaction` continue to use `operationKey`:

```ts
await ctx.transaction(({ collections }) => {
  collections.notes.create({ title: "One" });
  return new Map([["local-only", true]]);
}, { operationKey: "create-note" });
```

The callback runs locally and may return a local non-JSON value. Only its
canonical ordered operation plan crosses the owner boundary. Changed intent
under the same logical key conflicts. Public admission and current-authorized
result reads travel through the worker's real parentless reverse connection;
parent-bound child Actions retain their separate owner port. Execution grants
alone never grant ingress: the owner's current ingress policy must independently
authorize that worker, principal and route.

The construction namespace is fixed. A public call may repeat that namespace,
but cannot select another. Unsupported scope, metadata and other options fail
before admission. An optional signal interrupts the local wait; it does not
cancel the durable Action. An interrupted admitted wait retains its safe
reference in the error rather than claiming cancellation or silently
resubmitting.

`ready` describes the first current owner protocol handshake after the declared
fresh host checks. Every subsequent call checks the current session again.
Session replacement revokes outstanding waits and gates new calls on the new
handshake. Readiness does not certify restart recovery or perpetual
availability.

For storage placement, fatal owner retirement and worker closure both trigger
cleanup. `closed` resolves only after worker and host cleanup finish; a nonfatal
capacity diagnostic does not close the application. Cleanup starts both sides
without waiting for one peer to terminate the other. A lost COMMIT reply still
retains its unknown outcome and durable receipt; automatic cleanup does not make
that failed call safe to repeat with changed intent.

## Supported boundary and remaining gates

Ordinary JSON Actions and Processors use the existing bounded owner-backed
Collection transaction, child Action and effect capabilities. Unsupported
protected/content/deferred Action definitions refuse before worker startup;
unsupported context capabilities continue to fail explicitly. No worker-local
receipt store, SQL shortcut or owner-local authority is substituted.

Views remain present in the whole registry. This facade does not itself add
context/channel rendering, an HTTP route, or live UI support.

The deliberate worker entry exposes the same connected `createCopilotz`
implementation and shared authoring definitions. It rejects storage at both type
and runtime boundaries. Its production build must verify the complete emitted
runtime graph before optimization, retaining full subpath contracts or refusing
them. A passing declaration-only fixture is insufficient evidence for a deployed
worker artifact.
