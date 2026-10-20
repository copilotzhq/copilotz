---
title: "Chapter 21: Deploy and Scale"
description: "Run the same Notes plugin as a Gateway that owns the database and a Worker that executes without one over an explicit transport, and learn what a real multi-process deployment must provide."
section: Getting Started
order: 210
status: stable
---

# Chapter 21: Deploy and Scale

> Part 5 — Operate and Scale · Track: R · Requires: Chapter 7 (Chapter 15 for
> the Fetch section) · Needs: Deno 2.9+ or Node 24+ (no credential)

## The pain

Until now, every Notes entrypoint has called `createCopilotz` once. That single
application accepts requests, runs the `notes.capture` Processor, executes
`notes.save` and owns its database connection, all in one process. It works, but
it couples two jobs that scale differently. Accepting a request is cheap and
must stay responsive; executing Processors and Actions may be slow, may call
models or remote services, and is where you want more capacity. When the only
way to add execution capacity is to start another complete copy of everything,
you cannot size, restart or place the two jobs independently.

## The problem

Splitting the work must not split the application. Whichever process executes a
delivery has to see the same Events, records and operations as the process that
accepted the request, and it must register the same plugin IDs. The split
therefore needs three things to be explicit:

- **one owner of the data**: each database schema has one owner, a single
  serialized writer, and the Gateway holds it. A Worker opens no database; every
  read, write and Action call it makes goes to that owner, with the same
  namespace and schema. The persisted operation, not a process's memory, is the
  authority on what has happened;
- **a transport**: the accepting process needs a way to hand deliveries to
  executing processes and receive their results;
- **the same business definitions**: every role composes the same plugins, so
  stored IDs match registered declarations everywhere.

None of that should require rewriting `notes-plugin.ts`. Deployment is a host
decision, so it belongs in host composition and entrypoints.

## The solution

`createCopilotz` takes a `role` discriminant:

| `role`                  | What it does                                                                                                      | What it returns                                      |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| omitted or `"embedded"` | One local Gateway plus one local Worker in the same process. Everything earlier chapters used.                    | The full application, including `fetch`.             |
| `"gateway"`             | Accepts and admits requests, records operations, dispatches deliveries and serves observers. Runs no plugin work. | The full application (`send`, `attach`, …, `fetch`). |
| `"worker"`              | Connects to a Gateway over a transport and executes Processors and Actions for the deliveries it is given.        | Only `ready`, `closed` and `close(reason?)`.         |

A Worker holds no database connection. It rejects `database`, `persistence`,
`assets`, `authorization` and `databaseScopes`, and calls the Gateway's owner
for every read, write and Action call. Its plugin code is the same as in an
embedded application.

A Worker has no `send`, no `attach` and no `fetch`. Callers always go through a
Gateway. Choosing a role installs nothing extra: it does not add Core, agents or
an HTTP API. Each role composes exactly the plugins you pass.

`createCopilotzPersistence` from `@copilotz/copilotz/persistence` opens one
database connection that the host owns and lends to an embedded or Gateway role.
A role given `persistence` uses it but does not own it: closing the role leaves
it open, and the host closes it once, after the roles. You pass either
`persistence` or `database` to that role, never both.

### Create `topology.ts`

`topology.ts` is an **entrypoint** that proves the split locally. It creates one
host-owned in-memory persistence, a Gateway that holds it and a Worker in the
same process, and connects them with an explicit in-process transport. Its only
local import is `notes-plugin.ts`, the same pure definition every other chapter
uses. It does not import `composition.ts`, so this disposable fixture keeps its
own `:memory:` database instead of opening the `file://./data` directory that
`app.ts` and the servers use.

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

Each `finally` runs even when an earlier step throws, so a failed send still
closes the Worker, then the Gateway, then the database. If the Worker never
becomes ready, `worker.ready` rejects and the same cleanup runs.

`namespace`, `databaseSchema` and `plugins` must match across roles. Only the
Gateway receives the persistence.

### What changes for separate processes

The fixture keeps one in-memory database and an in-process transport, which only
exist inside one process. It shows the role contract; it is not a Cloud Run or
Kubernetes configuration. Separate Gateway and Worker processes need:

- **A durable database for the Gateway.** PostgreSQL, or a PGlite directory that
  only the Gateway process opens. Workers receive no database connection or
  credentials.
- **A real remote transport, hosted by the host.** Remote Workers connect over a
  WebSocket transport, and accepting those connections needs a runtime host
  adapter, not only a Fetch handler: `gateway.fetch` serves the HTTP facade, not
  Worker connections. Give the Gateway
  `transports: [{ type: "websocket", config: { path: "/workers" } }]` and an
  `admit` callback that checks each Worker's identity and credential, then serve
  it with `listen` from `@copilotz/copilotz/adapters/node` or
  `@copilotz/copilotz/adapters/deno`, which hosts both HTTP and Worker
  connections. Workers import `createCopilotz` from `@copilotz/copilotz/worker`,
  connect with `{ type: "websocket", config: { url } }` and supply `activate`,
  `register` and `handshake`. Hosts that own placement themselves pass a
  `dispatcher` callback instead, as the
  [Deployment Topologies reference](../../embedding-and-hypervisors.md)
  describes. Never expose a Worker endpoint without admission.
- **The same plugins in every role.** Workers need the business plugins they
  execute. The Gateway needs them too, to admit and route.

Capacity is configured, not inferred. `capacity` on each Worker bounds its
concurrent deliveries, and you add capacity by running more Workers. Copilotz
does not start a Worker per request or autoscale on load; your platform decides
how many Worker processes run.

Only the Gateway holds database connections, so adding Workers adds execution
capacity without adding database connections. Observers attach to the Gateway.
Size the database for the Gateway owners, and measure your own workload before
settling on numbers.

### Optional: serve HTTP from the Gateway

This section needs Chapter 15 for the basic `/api` facade and its loopback
development identity, and Chapter 16 for real authentication and tenant policy.

HTTP is a Gateway concern: a Worker has no `fetch`. The Gateway runs no durable
plugin work, but it can serve host-local reads and observers. Its `fetch` serves
the `/api` facade only when its plugins include `serverPlugin` with a facade
resource, as Chapter 15's `server.ts` composes; otherwise those routes answer
`404`. In a split deployment, the Gateway host composes the same server plugins,
authentication and `authorization` with `role: "gateway"`, and serves
`gateway.fetch` exactly as `serve.ts` serves `app.fetch`. The owner evaluates
the policy on the Gateway; Workers never register it. That `fetch` is the HTTP
facade only; Worker connections are hosted separately, as described above.
Workers compose only the business plugins.

### Before you deploy

These conditions are what make a deployment recoverable:

- **Durable state.** A durable database, and a durable Asset body backend when
  you configured one. Container disks are usually ephemeral, so a PGlite
  directory inside a container is lost on restart. Configuring body references
  does not move existing bodies out of the database.
- **Schema.** Startup validates the stored schema. Copilotz never runs a
  destructive or automatic data migration; plan upgrades with the
  [Upgrading reference](../../upgrading.md). Core applications can also install
  the explicit chronological history index once per physical schema; see
  [History Performance](../../history-performance.md). This provisioning is
  separate from the observation-catalog upgrade and is never request-time DDL.
- **Runtime assets.** Skill roots and local MCP server fixtures resolved with
  `import.meta.url` must be copied into the build next to the modules that
  reference them, or served over HTTP. Browsers and Workers-style runtimes
  cannot spawn local stdio MCP servers.
- **Credentials.** Model and service credentials stay in host composition on the
  processes that execute agents, never in plugin definitions.
- **Readiness.** Report a Worker host ready only after `worker.ready` resolves.
- **Shutdown.** On `SIGTERM`, stop accepting new requests, wait for the
  operations you already accepted to settle (their `done`, as `topology.ts`
  does) within your platform's grace period, then `close()` the Workers, the
  Gateway and finally the persistence. `close()` stops a role; it is not an
  unbounded wait for every delivery to drain.
- **Recovery.** Work interrupted by a shutdown or crash stays recorded. Eligible
  deliveries — pending, retryable, or held under an expired lease — are picked
  up again by a Worker. Cancelled, dead-lettered or failed work is not resumed
  automatically. Stable operation keys make repeated Collection writes and
  Action calls resolve to stored results (Chapter 7); effects in external
  services need those services' own idempotency.

## Check it works

**Deno:**

```sh
deno run -A topology.ts "Ship the release."
```

**Node 24+:**

```sh
node topology.ts "Ship the release."
```

Output resembles this:

```text
worker ready
event notes.capture.requested
event notes.save.invoked
event note.created
event notes.save.completed
settled operation: completed
```

Check these facts:

- `worker ready` appears before any Event.
- Exactly one `notes.save.invoked`, one `note.created` and one
  `notes.save.completed` appear: the Worker executed the original Processor and
  Action once.
- The final line reports `completed`, read by the Gateway from the database it
  owns.
- The process exits on its own, because all three resources were closed.

## What this unlocks

The same `notes-plugin.ts` now runs embedded, as a Gateway or as a Worker. You
can:

- size request acceptance and execution separately;
- add execution capacity by adding Workers with a configured `capacity`;
- keep the database, transport and HTTP choices in host code, with business
  definitions unchanged;
- know what a real multi-process deployment must supply: a durable database for
  the Gateway, an admitted remote transport, durable bodies and graceful
  shutdown.

## Next steps

- Next:
  [Chapter 22: Organize and Share Plugins](../part-6-evolve-and-reuse/22-organize-and-share-plugins.md)
  (requires Chapter 5) moves definitions into a reusable layout.
- Reference: [Embedding and Hypervisors](../../embedding-and-hypervisors.md)
  covers transports, Worker admission and injected dispatchers.
- Reference: [Runtime Adapters](../../runtime-adapters.md) lists host
  capabilities per runtime.
- Reference: [Upgrading](../../upgrading.md) and [API](../../api.md).
