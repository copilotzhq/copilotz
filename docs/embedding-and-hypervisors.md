# Embedding, Gateways, and Workers

Copilotz can run inside another application, split across local roles, or place
Workers remotely. Domain semantics do not change; the selected factories make
ownership and transport explicit.

## Embedded default

```ts
const app = await createCopilotz({ namespace: "acme" });
```

This creates a private in-memory Ominipg database plus a private Gateway and
Worker joined by an in-process event fabric. `app.shutdown()` owns all of them.
The returned application intentionally hides those topology details.

## Explicit in-process roles

```ts
import {
  createCopilotzGateway,
  createCopilotzWorker,
} from "@copilotz/copilotz";

const composition = {
  database: ominipg,
  namespace: "acme",
  plugins,
};
const transport = {
  type: "in-process",
  config: { topic: "acme.copilotz" },
} as const;
const workerId = "copilotz-acme";

const gateway = await createCopilotzGateway({
  ...composition,
  transports: [transport],
  target: { workerId },
});
const worker = await createCopilotzWorker({
  ...composition,
  id: workerId,
  transport,
});
await worker.ready;

// Application work enters through the Gateway.
const run = await gateway.run(input);
await run.done;

await Promise.all([gateway.shutdown(), worker.stop()]);
await closeOminipg();
```

The local `topic` is a rendezvous address, analogous to a WebSocket URL. It is
not a work broadcast topic. Oxian admits one Worker connection and assigns each
operation exactly; the event fabric carries the same lifecycle/protocol used by
remote transports.

An injected database is always application-owned. Copilotz never closes it.
Passing database configuration instead makes the Copilotz role own and close the
database it opens.

Gateway and Worker roles may share the same Ominipg instance in-process. One
instance safely serializes transaction ownership, while each Copilotz role
adapts it to its private narrow SQL seam. This avoids duplicate connections
without exposing a public session abstraction.

## Multiple physical schemas

`databaseSchema` selects the default physical schema. Additional schemas are
bound lazily through `application.databaseScope(name)` or an operation's
`databaseSchema`. Binding validates the clean four-table baseline with read-only
catalog SQL; it does not execute DDL. Tenant onboarding or migration must call
`provisionCopilotzSchema(database, name)` before traffic can select that scope.
A valid schema scope creates repositories and an isolated event hub only; it
does not create another database, Worker, Hypervisor, or scheduler.

HTTP requests cannot select a physical schema by context alone. A Gateway must
provide an explicit authorization resolver:

```ts
const gateway = await createCopilotzGateway({
  ...composition,
  http: {
    resolveContext: async (request) => {
      const tenant = await authenticateTenant(request);
      return {
        namespace: tenant.namespace,
        authorizedDatabaseSchema: tenant.databaseSchema,
      };
    },
  },
  resolveDatabaseSchema(request) {
    const value = request.context?.authorizedDatabaseSchema;
    if (typeof value !== "string") throw new Error("Tenant scope required.");
    return value;
  },
});
```

The resolver is the application's tenant-authorization boundary. A supplied
`context.databaseSchema` must match its result and cannot override it.

## WebSocket roles

The Gateway declares the server-side path:

```ts
const gateway = await createCopilotzGateway({
  ...gatewayComposition,
  transports: [{
    type: "websocket",
    config: { path: "/_copilotz/workers" },
  }],
  target: { workerId: "copilotz-acme" },
  admit,
}, {
  onWorkAccepted: recordAcceptedWork,
});

import { listen } from "@copilotz/copilotz/adapters/deno";
const listener = listen(gateway, { port: 8080 });
```

The outbound Worker declares its URL and identity lifecycle:

```ts
const worker = await createCopilotzWorker({
  ...workerComposition,
  id: "copilotz-acme",
  transport: {
    type: "websocket",
    config: { url: "wss://gateway.example/_copilotz/workers" },
  },
  activate,
  register,
  handshake,
}, {
  onReady: observeReady,
  onStart: observeStart,
});

await worker.ready;
```

The lifecycle functions decide identity, credentials, and handshake state. The
callbacks observe or gate important stages. Copilotz does not replace either
with hidden repository/authority objects.

Gateway and Worker processes construct equivalent plugins locally and use
shared/reachable persistence. Closures are never serialized. Dispatch carries
delivery/resource identity and Web Streams.

## One framed protocol

In-process and WebSocket transports share one versioned Copilotz output
protocol:

- semantic durable and ephemeral events;
- workload response metadata;
- raw output bytes;
- cancellation and operation completion.

Local transport can pass byte arrays directly; WebSocket adapters encode the
same frames on the wire. Raw bodies are chunked with backpressure. Large
semantic payloads belong in canonical assets and cross the protocol by
reference.

Worker-created durable events are relayed to the Gateway immediately. The
Gateway publishes them to attachments and schedules any new durable delivery
obligations. Ominipg remains the recovery authority if a connection fails after
commit but before relay.

## Application-owned dispatcher

An embedding application that already owns an Oxian Hypervisor or dispatcher can
inject it:

```ts
const gateway = await createCopilotzGateway({
  ...composition,
  dispatcher: applicationHypervisor,
  target: { workerId: "copilotz-acme" },
});
```

Copilotz never shuts down the injected dispatcher. Workers connect to the
transport owned by that infrastructure. Stable affinity is optional for durable
deliveries; workloads with process-local state need a stable target or an
external state service.

## HTTP and horizontally scaled Gateways

`gateway.fetch` is the portable HTTP boundary. Deno uses `listen(gateway)`;
Node, Bun, Cloudflare, browsers, or frameworks mount `gateway.fetch` directly.

A Gateway instance owns its live Worker connections and transient attachment
streams, but conversation state and delivery obligations remain durable. A
horizontally scaled deployment therefore uses one of these topologies:

- reconnectable Workers per Gateway instance, with load-balancer affinity only
  for the live WebSocket;
- an application-owned shared dispatcher/fleet behind all Gateways; or
- separate Gateway and Worker services with a stable routing layer.

Copilotz does not pretend an open WebSocket or raw audio stream can transfer
between instances. Oxian resume credentials reconnect lifecycle state; Ominipg
recovery resumes durable work. Realtime clients reconnect and reopen ephemeral
streams while retaining the same thread and semantic history.

Detailed implementation records: [engine assembly](v3/engine-assembly.md) and
[Oxian execution](v3/oxian-execution.md).
