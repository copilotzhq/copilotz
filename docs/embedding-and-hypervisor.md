# Embedding and hypervisors

The default engine creates one private in-process Oxian `WorkerHost`. It hosts a
long-lived Ominipg session workload and the Copilotz delivery/stream workloads.
This is the lightest setup for embedding Copilotz in another application: no
WebSocket boundary is involved.

```ts
const copilotz = await createCopilotz({
  database: { url: ":memory:" },
});
```

An application can own and inject shared infrastructure:

```ts
const copilotz = await createCopilotz({
  database: { instance: appOwnedOminipg },
  oxian: {
    dispatcher: appOwnedWorkerHost,
    target: { workerId: "copilotz-executors" },
  },
});
```

Injected Ominipg instances and dispatchers are never closed by
`copilotz.shutdown()`.

To host executors separately, create a worker runtime and attach its workloads:

```ts
import { createCopilotzWorkerRuntime } from "@copilotz/copilotz/worker";

const runtime = await createCopilotzWorkerRuntime({
  database: { instance: appOwnedOminipg },
  plugins,
  agents,
  tools,
});

const worker = host.attachInProcessWorker({
  workerId: "copilotz-1",
  workloads: runtime.workloads,
});
```

The engine and worker must resolve the same stable processor/provider/resource
IDs. A production hypervisor normally gives each long-lived worker its own
Ominipg session against the same PostgreSQL database. The engine dispatches only
identities and JSON metadata; media and execution output use Web Streams.

The same contracts work in Deno, Node, Bun, browsers, Cloudflare Workers, and
other Web-API runtimes when compatible database, provider, and dispatcher
adapters are injected. Filesystem plugin discovery and server listeners are
optional outer adapters rather than core imports.
