# Embedding, Gateways, and Workers

Copilotz has one public factory. `role` selects topology without creating a
second public API vocabulary.

## Embedded default

```ts
const app = await createCopilotz({ namespace: "acme", plugins });

const operation = await app.send(input);
await operation.done;
await app.close();
```

The embedded result exposes durable operation send/attach/status/list/cancel,
bounded maintenance, live observe, and close. It owns its private in-process
Gateway and Worker topology, and any database it created from configuration.
Injected database, dispatcher, and Hypervisor values remain application-owned.

## Split roles

Gateway and Worker are created through the same discriminated factory:

```ts
const composition = { namespace: "acme", plugins, persistence };
const transport = {
  type: "in-process",
  config: { topic: "acme.copilotz" },
} as const;

const gateway = await createCopilotz({
  role: "gateway",
  ...composition,
  transports: [transport],
  target: { workerId: "acme-worker" },
});
const worker = await createCopilotz({
  role: "worker",
  ...composition,
  id: "acme-worker",
  transport,
});

await worker.ready;
await gateway.send(input);
await Promise.all([gateway.close(), worker.close()]);
```

Gateway is the public application base plus `fetch(request)`. Worker is the
narrow host handle `{ ready, closed, close }`. Neither role exposes the private
application, engine, database scopes, event stores, or Hypervisor.

## HTTP and WebSocket hosts

`gateway.fetch` is portable Fetch. Composing `createServerPlugin()` installs the
single public `/api` facade. No internal or versioned HTTP router is mounted.
Oxian applications use it directly as their handler; a Deno listener also
accepts the same structural Fetch-capable host:

```ts
import { listen } from "@copilotz/copilotz/adapters/deno";

const listener = listen(gateway, { port: 8080 });
```

For WebSocket Workers, configure the Gateway transport with its path and supply
the Worker with the corresponding outbound URL, identity, registration, and
handshake callbacks. Gateway and Worker processes reconstruct equivalent plugin
composition locally; functions and database objects never cross the transport.

## Shared persistence

`@copilotz/copilotz/persistence` exports `createCopilotzPersistence()` for an
embedding that deliberately shares one reconnectable Ominipg facade between
roles. Pass it as `persistence`, then close that record from the embedding after
all roles close. Database configuration passed directly to a role is instead
owned by that role.

Durable events and delivery obligations remain the recovery authority. A lost
connection rejects the affected operation as indeterminate, bounds admission of
new work, and resumes durable processing after reconnection.

Every selected physical schema must already be a validated v4 schema. Ordinary
role startup never mutates a legacy schema; run the explicit
[0.47/0.48 migration](migration-v4.md) first.
