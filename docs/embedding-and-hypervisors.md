---
title: "Deployment Topologies"
description: "Place the same plugins in one embedded process, or split them into a Gateway and Workers that share persistence and an admitted transport."
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
- **What is the source of truth?** Every role must read and write the same
  persisted Events, records and operations, with the same namespace, schema and
  plugin IDs.
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

Roles depend on two Oxian libraries in different ways. **Ominipg** is the
durable store: Events, delivery obligations and records live there, and recovery
reads them back. The **Oxian Hypervisor** only places execution: it dispatches a
delivery to a Worker and relays its output. When a placement is lost, a delivery
that is still pending, retryable or held under an expired lease is placed again.
Failed, cancelled and dead-lettered work is not resumed automatically. The
Hypervisor is never the recovery authority.

### Shared persistence

`createCopilotzPersistence` from `@copilotz/copilotz/persistence` opens one
connection that several roles in the same process share. Configure recovery and
lifecycle observation when you create it:

- `database`: Ominipg options such as `{ url }`, a reconnect-capable
  `{ connect(context) }` connector, or an already open database;
- `databaseRecovery`: `waitMs`, `retryAfterSeconds`, `reconnectDelayMs` and an
  optional `isUnavailable` classifier;
- `databaseLifecycle`: `onUnavailable`, `onReconnecting` and `onReady`
  callbacks. Copilotz awaits them as part of the recovery cycle, so keep them
  fast and non-throwing; a slow or failing hook delays or disturbs recovery.

A role receives either `persistence` or its own `database`, never both, and a
role given `persistence` rejects `databaseRecovery` and `databaseLifecycle`.
Roles never close a shared persistence; the host closes it once, after every
role. An open database you inject is never closed or replaced by Copilotz,
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
with `@copilotz/copilotz@^0.86.3`.

`topology.ts` runs a Gateway and a Worker in one process over an explicit
in-process transport, sharing one persistence the host owns. It is the same file
as
[Chapter 21](getting-started/part-5-operate-and-scale/21-deploy-and-scale.md).

```ts
// The role-aware factory and the guard that separates byte streams from Events.
import { createCopilotz, isStreamOutput } from "@copilotz/copilotz";
// Type of each item a send handle streams.
import type { ApplicationOutput } from "@copilotz/copilotz";
// One database connection that several roles can share without owning it.
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
// self-contained; every role below reads and writes this one connection.
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
    // same persistence, same transport record.
    const worker = await createCopilotz({
      role: "worker",
      persistence,
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

      // The Gateway reads the outcome back from shared persistence.
      const status = await gateway.operationStatus({
        operationId: handle.operationId,
      });
      console.log(`settled operation: ${status?.state ?? "unknown"}`);
    } finally {
      // Stop executing; this does not close the shared persistence.
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
`settled operation: completed`, read by the Gateway from the shared persistence.
Each `finally` runs even when an earlier step throws, so a failed send still
closes the Worker, then the Gateway, then the database.

### Separate processes

The in-process transport and the shared persistence object exist only inside one
process. A local `file://` PGlite directory is likewise opened by one connection
in one process, and cannot be shared across processes or hosts. Separate Gateway
and Worker processes need:

- **A shared PostgreSQL server.** Each process opens its own connection with the
  same namespace and schema. Add a durable Asset body backend if you configured
  body references.
- **The same plugins in every role.** Workers need the plugins they execute; the
  Gateway needs them to admit and route.
- **A host-owned WebSocket Hypervisor.** `gateway.fetch` is a plain Fetch
  handler: it serves the facade and cannot upgrade WebSocket connections. The
  public Gateway also hides its Hypervisor. To host remote Workers:
  1. install the public Oxian package, `jsr:@oxian/oxian-js`, next to Copilotz;
  2. create your own Hypervisor with `createHypervisor` from
     `@oxian/oxian-js/hypervisor`, configured with a
     `{ type: "websocket", config: { path } }` transport, an `admit` callback
     implementing your host's registration and resume credential policy, and a
     `fallback` that delegates ordinary requests to `gateway.fetch`;
  3. pass that Hypervisor to the Gateway as `dispatcher` instead of
     `transports`. An injected dispatcher owns admission, so the Gateway then
     rejects `transports`, `admit`, `assign`, `sessions` and `hypervisorConfig`;
  4. serve it with `listen({ hypervisor })` from
     `@copilotz/copilotz/adapters/deno`;
  5. give each Worker `{ type: "websocket", config: { url } }` with `activate`,
     `register` and `handshake` callbacks that follow the same credential
     policy;
  6. shut the Hypervisor down yourself after the Gateway closes; Copilotz never
     closes an injected dispatcher.

  The registration and resume credential protocol belongs to Oxian; see the
  [`@oxian/oxian-js` package documentation](https://jsr.io/@oxian/oxian-js).
  Never expose a Worker endpoint without admission.

The HTTP API is separate from Worker hosting. The Gateway's facade serves `/api`
only when its plugins include the authenticated server definition from
[Chapter 15](getting-started/part-4-release-to-users/15-expose-an-http-api.md)
and
[Chapter 16](getting-started/part-4-release-to-users/16-authenticate-and-isolate-tenants.md);
otherwise ordinary routes answer `404`. See [Server](server.md).

### Shutdown and recovery

`close()` stops a role without waiting for every delivery. A graceful host first
stops admitting new requests, awaits the operations it already accepted within
its grace period, then closes Workers, listeners and the Gateway, any host-owned
Hypervisor, and finally the shared persistence. Work interrupted anyway stays
recorded, and deliveries that are pending, retryable or under an expired lease
are picked up by a Worker later. Report a Worker host ready only after
`worker.ready` resolves.

## Reference

- **Capacity** is configured per Worker with `capacity` (default 8). Add
  capacity by running more Workers; Copilotz does not autoscale or start a
  Worker per request.
- **Connections** multiply with processes: each one opens its own pool, polling
  and observers. Size PostgreSQL `max_connections` for the total and measure
  your own workload; see [Observation Performance](observation-performance.md).
- **Host limits**: `listen({ hypervisor })` is the Deno adapter; hosting
  WebSocket Workers this way is Deno-only. Having a `fetch` handler does not by
  itself make a browser or Workers-style runtime a supported database-backed
  Gateway host; check [Runtime Adapters](runtime-adapters.md) for each runtime's
  capabilities.
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
