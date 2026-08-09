# Embedding and Hypervisors

Copilotz can run inside another application or behind its own server. The domain
model does not change; only ownership and Oxian placement do.

## Private defaults

```ts
const app = await createCopilotz({ namespace: "acme" });
```

This creates a private in-memory Ominipg session plus a private Oxian Hypervisor
and in-process Workers. `app.shutdown()` owns them all.

## App-owned database and shared Hypervisor

```ts
import { createCopilotzApplication } from "@copilotz/copilotz/application";
import { createHypervisor } from "@oxian/oxian-js/hypervisor";

const transport = {
  type: "in-process",
  config: { topic: "acme.copilotz" },
} as const;

const hypervisor = createHypervisor({
  transports: [transport],
}, {
  onWorkAccepted: persistWorkAcceptance,
});
const app = await createCopilotzApplication({
  session: ominipgSession,
  namespace: "acme",
  plugins,
  engine: {
    execution: { hypervisor, transport, workerId: "copilotz-acme" },
  },
});

await app.shutdown(); // detaches Copilotz only
await hypervisor.shutdown(); // embedding app decides when
await closeOminipg();
```

An injected SQL session is not closed unless `closeSession` explicitly grants
ownership. A shared Hypervisor remains usable after Copilotz stops its Workers.
The transport topic is an explicit same-realm rendezvous address, not a work
broadcast topic. Passing the same declaration makes the embedding topology
visible and lets Oxian run its complete Worker lifecycle over the local event
fabric.

## Hypervisor dispatcher

For remote/shared placement, inject `engine.execution.dispatcher` and a logical
target. The remote worker hosts `copilotz.delivery.v1` and, for attachments,
`copilotz.stream.v1` against the same reachable event/domain storage and plugin
registry. Dispatch metadata contains delivery/resource identities only.

A worker-side application creates the same registry and database capabilities,
then exposes its locally closed-over workload handlers for registration:

```ts
const workerApplication = await createCopilotzApplication({
  session: workerSession,
  namespace: "acme",
  plugins,
});

const worker = createWorker({
  id: "copilotz-acme",
  transport: {
    type: "websocket",
    config: { url: hypervisorUrl },
  },
  activate,
  register,
  handshake,
  workloads: workerApplication.execution.workloads,
});

await worker.ready;
```

The handlers are never serialized. Each process constructs them locally; the
Hypervisor transports only operation metadata and Web Streams. Gateway and
worker processes need shared/reachable persistence plus an event publication
mechanism when live output must cross process boundaries.

`createWorker()` starts immediately. Its `activate`, `register`, and `handshake`
functions own application-specific identity, credentials, and bootstrap
persistence; lifecycle callbacks are passed as the factory's second argument
when the embedding application needs to observe or gate stages.

Copilotz never shuts down an injected dispatcher. Worker affinity is optional
for durable deliveries; workloads that hold process-local state, such as a
persistent terminal, should receive a stable target or use an external service.

## Server mode

```ts
import {
  createEventNativeApp,
  createEventNativeFetchHandler,
} from "@copilotz/copilotz/server";

const handler = createEventNativeFetchHandler(
  createEventNativeApp(app),
  { basePath: "/v3" },
);

// Mount `handler(request)` in Deno, Node, Bun, a service worker, or Cloudflare.
```

The server boundary is the Web Fetch contract and does not own a framework or
listen socket.

Detailed contracts: [engine assembly](v3/engine-assembly.md) and
[Oxian execution](v3/oxian-execution.md).
