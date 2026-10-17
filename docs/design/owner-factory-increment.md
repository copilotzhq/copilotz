# Bounded owner-backed factory increment

Status: experimental ordinary-Action composition. This is a partial application
surface, not completion of the owner, wire, recovery or View contracts.

`createCopilotz` accepts either `storage` or `owner`, with the same plugin
composition and namespace in both placements. The existing embedded/Gateway/
Worker options remain a separate compatibility path. Mixing these paths fails;
there is no automatic fallback from an unavailable owner to legacy persistence.

## Placement and prerequisites

The storage placement requires an explicit SQL session, schema, owner ID, holder
ID, initialization mode, current trusted host policies, and compatible transport
factories. The SQL session remains caller-owned after close or failed startup.

- `initialization: "fresh"` requires complete current business-state emptiness
  inside the acquired owner fence. It provisions base schemas and declared
  Collection indexes, then validates them before readiness. Restart inventory
  budgets do not impose a separate limit on fresh registry size.
- `initialization: { mode: "resume", expectedEpoch: 1 }` means that **1 is the
  expected prior durable epoch**, not the acquired successor epoch. Acquisition
  compares that expectation and fences the previous owner; a successful takeover
  in this example acquires epoch 2. Use the actual expected prior epoch rather
  than assuming every restart follows epoch 1.

Resume validates all retained schemas and indexes without provisioning missing
pieces or performing a migration. Bounded repair passes establish required
alarms, retire only proven prior reservations, and settle supported closed
operations. Independent receipt-free current proofs run before and after
transport construction. Ingress and dispatch remain unavailable until the final
proof commits under the acquired epoch. Unknown acquisition/repair/proof
outcomes stop that startup instance; construction failures close created
transports.

The existing public `namespace` is forwarded as trusted graph coverage. It is
captured before asynchronous startup work and is never inferred from stored
rows, plugin registration or request metadata. Every retained graph row must
belong to that namespace and match the registered ordinary Collection
projection, including identity, search text, timestamps and supported declared
relation edges. This is present-state compatibility, not historical
authorization. Current policy still runs on every subsequent command and result
read.

The currently supported resume histories are never-started pending ordinary
Action/Processor deliveries and exact canonical ordinary terminal histories,
including ordinary Collection records and declared relation edges. Retry-wait,
lost/leased executions, open Actions, unresolved effects, owner-local attempt
history, prepared/protected/content/deferred/stream history, unsupported graph
kinds and unindexed direct Collection history remain explicit blockers. Nothing
is inferred safe merely because an effect receipt or reservation is absent.

Optional resume budgets are `maxItems` (default 1,000; maximum 10,000),
`maxBytes` (default 8 MiB; maximum 32 MiB), and `maxPasses` (default 4; maximum
16). Omit an optional field to use its default; null, undefined and other
malformed numeric values refuse before SQL. Items/bytes are shared across
captured graph configuration, raw graph/history inventory and derived graph
state. Overflow refuses rather than truncating proof. Physical catalog checks
have a separate fixed metadata envelope: 1,000 aggregate rows, 8,192-byte
expression/predicate caps and a bounded declared-index reread. These are
retained-evidence bounds, not total process-memory or SQL-work limits; arbitrary
concurrent DDL remains outside the owner contract.

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
  storage, // Explicit fresh/resume storage and current policy, described above
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
fresh or supported resume checks. Every subsequent call checks the current
session again. Session replacement revokes outstanding waits and gates new calls
on the new handshake. Readiness does not certify recovery of the explicitly
unsupported histories above or perpetual availability.

The retained public acceptance fixture exercises the same whole plugin over
in-process and WebSocket workers: root Action → Collection write → Processor →
child Action. It closes a settled owner, resumes twice, verifies terminal replay
adds no events or claims, preserves same-key changed-input conflicts, and runs
new work under the successor epoch. Records are produced through public Action
calls, not inserted as restart fixture state.

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
