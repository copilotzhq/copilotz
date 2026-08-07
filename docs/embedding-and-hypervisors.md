# Embedding and Hypervisors

Copilotz can run inside another application or behind its own server. The domain
model does not change; only ownership and Oxian placement do.

## Private defaults

```ts
const app = await createCopilotz({ namespace: "acme" });
```

This creates a private in-memory Ominipg session and private in-process Oxian
host. `app.shutdown()` owns both.

## App-owned database and shared host

```ts
import { createCopilotzApplication } from "@copilotz/copilotz/application";
import { createWorkerHost } from "@oxian/oxian-js/host";

const host = createWorkerHost({ persistAcceptance });
const app = await createCopilotzApplication({
  session: ominipgSession,
  namespace: "acme",
  plugins,
  engine: {
    execution: { host, workerId: "copilotz-acme" },
  },
});

await app.shutdown(); // detaches Copilotz only
await host.shutdown(); // embedding app decides when
await closeOminipg();
```

An injected SQL session is not closed unless `closeSession` explicitly grants
ownership. A shared host remains usable after Copilotz detaches its worker.

## Hypervisor dispatcher

For remote/shared placement, inject `engine.execution.dispatcher` and a logical
target. The remote worker hosts `copilotz.delivery.v1` and, for attachments,
`copilotz.stream.v1` against the same reachable event/domain storage and plugin
registry. Dispatch metadata contains delivery/resource identities only.

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
