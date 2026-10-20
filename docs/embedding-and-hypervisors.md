---
title: "Deployment Topologies"
description: "Place the same plugins in one embedded process, or split them into a Gateway that owns the database and Workers that call it over an admitted transport."
section: Operate
order: 40
status: stable
---

# Deployment Topologies

## The pain

An application starts as one `createCopilotz` call that accepts requests,
executes Processors and Actions, and owns its database. Later you need more
execution capacity without more request front ends, or you want slow model and
service work on machines separate from the HTTP edge. Starting several complete
copies of the application does not give you that split, and wiring processes
together by hand risks two processes disagreeing about plugins, schema or which
delivery has already run.

## The problem

A split deployment needs explicit answers to four questions:

- **Who accepts and who executes?** One role must admit requests and record
  operations; others execute deliveries.
- **What is the source of truth?** One owner per database schema writes
  persisted Events, records and operations. Workers receive its capabilities;
  namespaces select data within that owner.
- **How does work move?** The accepting process needs a transport to place
  deliveries on executing processes, and remote executors must be admitted, not
  simply allowed to connect.
- **Who owns what?** Database connections, transports and listeners have to be
  closed exactly once, in an order that does not strand work.

## The solution

### One factory, three roles

`createCopilotz` takes a `role` discriminant. The same plugins run in every
role; a role never adds Core, agents or HTTP on its own.

| `role`                  | Responsibility                                                                                                         | Public handle                                                                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| omitted or `"embedded"` | A private Gateway and Worker in one process.                                                                           | `send`, `attach`, `operationStatus`, `listOperations`, `operationCheckpoint`, `cancelOperation`, `maintenance`, `observe`, `close`, `fetch` |
| `"gateway"`             | Admits requests, records operations, dispatches deliveries, serves observers and the HTTP facade. Runs no plugin work. | Same as embedded.                                                                                                                           |
| `"worker"`              | Executes Processors and Actions for deliveries placed on it.                                                           | `ready`, `closed`, `close(reason?)`                                                                                                         |

No role exposes its internal application, engine, database scopes or Hypervisor.
A Worker has no `send` or `fetch`: callers always go through a Gateway.

The Gateway activates the schema owner before admission: it acquires the epoch,
invalidates stale delivery attempts, and recovers the operation catalog. Storage
commands serialize behind a locking epoch fence; provider work remains
concurrent. Workers execute through this owner and do not open a database or
application. Configure storage and `engine` settings on the Gateway.

The owner-capability connection uses in-process or WebSocket transport. Workers
can run in separate Node processes or browsers; only the owner opens storage.
Use the portable `/worker` entry in browser bundles. Embedded placement is a
trusted same-process convenience, not isolation from hostile plugin code.

Roles depend on two Oxian libraries in different ways. **Ominipg** is the
durable store: Events, delivery obligations and records live there, and recovery
reads them back. The **Oxian Hypervisor** only places execution: it dispatches a
delivery to a Worker and relays its output. When a placement is lost, a delivery
that is still pending, retryable or held under an expired lease is placed again.
Failed, cancelled and dead-lettered work is not resumed automatically. The
Hypervisor is never the recovery authority.

### Shared persistence

`createCopilotzPersistence` from `@copilotz/copilotz/persistence` opens one
connection that the host owns and lends to embedded and Gateway roles in the
same process. Configure recovery and lifecycle observation when you create it:

- `database`: Ominipg options such as `{ url }`, a reconnect-capable
  `{ connect(context) }` connector, or an already open database;
- `databaseRecovery`: `waitMs`, `retryAfterSeconds`, `reconnectDelayMs` and an
  optional `isUnavailable` classifier;
- `databaseLifecycle`: `onUnavailable`, `onReconnecting` and `onReady`
  callbacks. Copilotz awaits them as part of the recovery cycle, so keep them
  fast and non-throwing; a slow or failing hook delays or disturbs recovery.

An embedded application or Gateway receives either `persistence` or its own
`database`, never both, and a role given `persistence` rejects
`databaseRecovery` and `databaseLifecycle`. Workers use the colocated Gateway
owner. Roles never close a shared persistence; the host closes it once, after
every role. An open database you inject is never closed or replaced by Copilotz,
because it cannot be reconnected; pass a connector when you want reconnection.

During an outage, new admissions wait up to `waitMs` and then fail with
`persistence_unavailable` (HTTP `503` with `Retry-After`). An operation whose
outcome cannot be confirmed rejects with `persistence_indeterminate`.
Reconnection does not replay that failed database call: the caller inspects
durable state (for example `operationStatus` or `attach`) and, if needed,
retries with the original request identity. What resumes after reconnection is
eligible durable deliveries, not arbitrary failed transactions.

Startup validates the stored schema and rejects incompatible ones. Plan schema
and catalog changes with [Upgrading](upgrading.md).

### Create `topology.ts`

This needs `notes-plugin.ts` from
[Chapter 5](getting-started/part-1-design-and-build/05-package-a-plugin.md) and
the project setup from [Getting Started](getting-started.md#before-you-start)
with `@copilotz/copilotz@^0.89.0`.

`topology.ts` runs a Gateway and a Worker in one process over an explicit
in-process transport, sharing one persistence the host owns. It is the same file
as
[Chapter 21](getting-started/part-5-operate-and-scale/21-deploy-and-scale.md).

```ts
// The role-aware factory and the guard that separates byte streams from Events.
import { createCopilotz, isStreamOutput } from "@copilotz/copilotz";
// Type of each item a send handle streams.
import type { ApplicationOutput } from "@copilotz/copilotz";
// One database connection the host owns and lends to the Gateway.
import { createCopilotzPersistence } from "@copilotz/copilotz/persistence";
// The unchanged business definitions: Collection, Action and Processor.
import { notesPlugin } from "./notes-plugin.ts";
// The note text comes from the command line.
import { argv } from "node:process";

// Both roles must agree on the tenant; records and operations live in it.
const namespace = "team-notes";

// The identity the Gateway targets and the Worker registers under.
const workerId = "notes-worker-1";

// Both roles must also agree on the database schema. "public" is the default;
// it is spelled out so the pairing is visible.
const databaseSchema = "public";

// One transport record, passed to both roles. In-process transport works only
// inside this process; separate processes need a remote transport.
const transport = {
  type: "in-process",
  config: { topic: "team-notes.topology" },
} as const;

// Prints the facts this check needs: whether each output is stored, and its type.
async function printOutputs(
  outputs: ReadableStream<ApplicationOutput>,
): Promise<void> {
  for await (const output of outputs) {
    // Notes opens no byte streams; release any so they cannot block settlement.
    if (isStreamOutput(output)) {
      await output.payload.cancel();
      continue;
    }
    console.log(`${output.durable ? "event" : "live"} ${output.type}`);
  }
}

// Host-owned persistence. A private in-memory database keeps this fixture
// self-contained; the Gateway owner alone writes through this connection.
const persistence = await createCopilotzPersistence({
  database: { url: ":memory:" },
});

try {
  // Accepts requests and dispatches deliveries. It registers the plugin so it
  // can validate and route, but runs no Processor or Action itself.
  const gateway = await createCopilotz({
    role: "gateway",
    persistence,
    namespace,
    databaseSchema,
    plugins: [notesPlugin],
    // The transports Workers connect over.
    transports: [transport],
    // Send deliveries to this Worker.
    target: { workerId },
  });
  try {
    // Executes the Notes Processor and Action. Same plugin, same namespace,
    // same owner capabilities and transport record.
    const worker = await createCopilotz({
      role: "worker",
      namespace,
      databaseSchema,
      plugins: [notesPlugin],
      id: workerId,
      transport,
      // How many deliveries this Worker runs at once.
      capacity: 4,
    });
    try {
      // Do not accept work until the Worker has connected and registered.
      await worker.ready;
      console.log("worker ready");

      // Send through the Gateway exactly as app.ts does.
      const handle = await gateway.send({
        type: "notes.capture.requested",
        payload: { text: argv[2] ?? "Prepare the release." },
      });
      // Wait for the reader and settlement before cleanup, even if either fails.
      const [drained, settled] = await Promise.allSettled([
        printOutputs(handle.outputs),
        handle.done,
      ]);
      if (drained.status === "rejected") throw drained.reason;
      if (settled.status === "rejected") throw settled.reason;

      // The Gateway reads the outcome back from the database it owns.
      const status = await gateway.operationStatus({
        operationId: handle.operationId,
      });
      console.log(`settled operation: ${status?.state ?? "unknown"}`);
    } finally {
      // Stop executing; the Worker never held the database.
      await worker.close();
    }
  } finally {
    // Stop accepting and dispatching; also leaves persistence open.
    await gateway.close();
  }
} finally {
  // The host created the persistence, so the host closes it, once, last.
  await persistence.close();
}
```

Run it on Deno or Node 24+:

```sh
# Deno
deno run -A topology.ts "Ship the release."
# Node 24+
node topology.ts "Ship the release."
```

The output starts with `worker ready`, shows one `notes.save.invoked`,
`note.created` and `notes.save.completed`, and ends with
`settled operation: completed`, read by the Gateway from the database it owns.
Each `finally` runs even when an earlier step throws, so a failed send still
closes the Worker, then the Gateway, then the database.

### Separate processes

The in-process transport and the host's persistence object exist only inside one
process. A local `file://` PGlite directory is likewise opened by one connection
in one process, and cannot be shared across processes or hosts. Separate Gateway
and Worker processes need:

- **Owner-only persistence.** A Gateway may use PostgreSQL or its own durable
  PGlite directory. Workers receive no database connection or credentials.
- **Matching declarations.** Workers execute their plugins; the owner validates
  their registered Actions, Collections, Processors and Views.
- **Authenticated WebSocket admission.** Configure Gateway `transports` with
  `{ type: "websocket", config: { path: "/workers" } }` and an `admit` callback
  implementing the host's registration/resume policy. Never expose an unguarded
  Worker endpoint.
- **A public host adapter.** On Node, `await listen(app, options)` from
  `@copilotz/copilotz/adapters/node` serves both HTTP and worker WebSockets. On
  Deno, the same adapter name from `/adapters/deno` returns the listener
  synchronously. Both resolve the existing owner's transport internally; no
  owner, session or Hypervisor is exposed on the application handle.
- **Portable workers.** Import `createCopilotz` from
  `@copilotz/copilotz/worker`, with role `worker`, matching declarations and the
  admitted WebSocket URL. Supply `activate`, `register` and `handshake`
  callbacks according to the host's credential policy. Await `worker.ready`
  before reporting readiness.

Advanced hosts can own placement explicitly with the Gateway's trusted
`dispatcher({ workerCalls, lifecycle })` callback. Construct the caller-owned
Hypervisor with exactly those frozen owner bindings before workers connect, and
return it. The callback runs once before recovery; returning an existing unbound
dispatcher object is a configuration error. Copilotz revokes its bindings on
initialization failure and close but never shuts down caller-owned placement.
The caller cleans up its own construction failures/cancellation and closes that
Hypervisor after the application. Serve a caller-owned Hypervisor through
`listen({ hypervisor })`; the host also supplies its HTTP fallback. The bindings
carry capability admission and lifecycle only, never persistence.

The returned dispatcher must expose its actual accepted session authority as
`sessions`, with `assertCurrent` and `subscribe`. A pinned Oxian Hypervisor can
be returned directly. Copilotz captures these methods before activation and
rejects missing subscriptions at startup. It renews remote delivery attempts
only after Oxian accepts a strictly advancing heartbeat sequence for their
current worker identity, connection and session generation. Each bounded batch
rechecks session and durable invocation authority after the owner fence; an
expired attempt cannot be revived. The preaccept `onHeartbeat` callback is not
renewal evidence. Caller-owned dispatchers must forward their actual session
authority rather than creating a second registry.

The former execution `heartbeatMs` and `scheduler` options and exported
`DeliveryWorkloadScheduler` type have been removed. Remove these options from
advanced executor/workload configuration. Remote delivery renewal now follows
the transport's accepted heartbeats, without a per-delivery owner timer.
Embedded execution continues to use local attempts without lease deadlines or
remote session requirements. Quiet stream writers remain valid for their
invocation lifetime; bounded reader and snapshot timeouts still apply. Session
liveness does not impose an execution-progress timeout.

The registration and resume protocol belongs to Oxian; see the
[`@oxian/oxian-js` package documentation](https://jsr.io/@oxian/oxian-js).

The HTTP API is separate from Worker hosting. The Gateway's facade serves `/api`
only when its plugins include the authenticated server definition from
[Chapter 15](getting-started/part-4-release-to-users/15-expose-an-http-api.md)
and
[Chapter 16](getting-started/part-4-release-to-users/16-authenticate-and-isolate-tenants.md);
otherwise ordinary routes answer `404`. See [Server](server.md).

### Shutdown and recovery

Application `close()` also closes listeners created by `listen(app)`. Closing a
listener alone closes its connections, leaves the owner alive, and permits a
replacement listener. A listener whose asynchronous startup races application
close is shut down before it can be returned. Explicit `listen({ hypervisor })`
listeners and caller-owned Hypervisors remain the host's responsibility.

`close()` stops a role without waiting for every delivery. A graceful host first
stops admitting new requests, awaits the operations it already accepted within
its grace period, then closes Workers, listeners and the Gateway, any host-owned
Hypervisor, and finally the persistence. Work interrupted anyway stays recorded,
and deliveries that are pending, retryable or under an expired lease are picked
up by a Worker later. Report a Worker host ready only after `worker.ready`
resolves.

### Interrupted placement and logical replay

A trusted worker-connection loss does not create a failed or cancelled Action
receipt. The owner retires that exact connection/session/stream assignment and
waits for its admitted calls and resource cleanup. A replacement must obtain
fresh owner authority; a late completion from the retired assignment cannot
settle its successor.

- Before execution admission, no Action or effect has started.
- After a database commit whose reply was lost, the same logical Action or
  Processor command can recover its exact receipt after current authorization; a
  new worker placement does not change the logical mutation identity.
- After an external effect has begun without confirmation, the replacement
  checks the durable effect inventory before user code runs. It requires the
  declared reconciliation protocol or reports an indeterminate outcome; it never
  blindly redispatches the external effect.
- An already accepted terminal Action receipt remains authoritative even if its
  response was lost. Explicit caller cancellation and accepted worker business
  failures retain their semantic outcomes.

Only the owner transport lifecycle classifies physical interruption. A worker
error message or a `connection_lost` error code cannot request replay authority.

## Reference

- **Capacity** is configured per Worker with `capacity` (default 8). Add
  capacity by running more Workers; Copilotz does not autoscale or start a
  Worker per request.
- **Connections** belong to owners, never workers. Size PostgreSQL
  `max_connections` for the owner pools and measure your own workload; see
  [Observation Performance](observation-performance.md).
- **Host limits**: Node and Deno adapters host worker WebSockets. Having a
  `fetch` handler does not by itself make a browser or Workers-style runtime a
  supported database-backed Gateway host; check
  [Runtime Adapters](runtime-adapters.md) for each runtime's capabilities.
- **HTTP policy**: once composed, the facade behind `fallback` enforces the same
  authentication and exposure as an embedded `app.fetch`. Worker admission
  protects only the Worker endpoint.

## What this unlocks

- Keep `notes-plugin.ts` and every other definition unchanged across embedded,
  Gateway and Worker placement.
- Scale execution independently of request acceptance.
- Survive database outages with bounded admission and durable recovery.
- Admit remote Workers explicitly instead of exposing an open endpoint.

## Next steps

- Tutorial:
  [Chapter 21: Deploy and Scale](getting-started/part-5-operate-and-scale/21-deploy-and-scale.md)
  walks through the split step by step.
- Reference: [Events, Deliveries and Recovery](events-deliveries-recovery.md)
  explains what a Worker resumes.
- Reference: [Server](server.md) for the facade behind `fallback`.
- Reference: [Upgrading](upgrading.md) before changing schemas.
