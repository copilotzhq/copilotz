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

`namespace` is the tenant boundary. It is the default for every operation the
application runs, and an operation may name its own. Copilotz never chooses one:
a send with neither the application nor the operation naming a namespace is
rejected, so a missing tenant cannot silently pool data. A single-tenant app
uses any fixed name, such as `"acme"`.

The embedded result exposes durable operation send/attach/status/list/cancel,
bounded maintenance, live observe, close, and the same `fetch` as a Gateway.
With `serverPlugin` composed, `fetch` serves the `/api` facade, so a
single-process web application can pass `app.fetch` to any Fetch listener. It
owns its private in-process Gateway and Worker topology, and any database it
created from configuration. Injected database, dispatcher, and Hypervisor values
remain application-owned.

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

`gateway.fetch` is portable Fetch. Composing `serverPlugin` installs the single
public `/api` facade. No internal or versioned HTTP router is mounted. Oxian
applications use it directly as their handler; a Deno listener also accepts the
same structural Fetch-capable host:

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

Every selected physical schema must be a validated v5 schema. Ordinary role
startup rejects incompatible schemas. This release provides no data migration.

## Sizing the connection pool

A turn is a serial chain of short statements: an ordinary reply is about 60 and
a reply with one tool call about 140. It is busy nearly all of the time, so each
turn in flight keeps about 1.2 PostgreSQL connections occupied. When the pool is
smaller than the turns in flight, statements wait for a connection and latency
grows in proportion.

Measured on PostgreSQL with 5 ms of network round trip and one tool call per
turn (median turn latency in milliseconds; a lone turn takes about 900):

| Turns in flight | pool 3 | pool 5 | pool 8 | pool 12 | pool 16 |
| --------------: | -----: | -----: | -----: | ------: | ------: |
|               1 |    932 |    901 |    949 |     975 |     908 |
|               4 |   2088 |   1082 |    950 |     924 |     892 |
|               8 |   4818 |   2344 |   1345 |    1216 |    1194 |

Set `pgPoolMax` (an Ominipg option, default 5) to at least 1.5 connections for
every turn you expect to run at once. Beyond about 2 per turn there is nothing
left to gain. The number of turns that run at once is bounded by the worker
capacity (`capacity`, default 8), so the defaults are matched by a pool of 12 to
16. Raise both together, and keep the total across processes below the
database's `max_connections`.

Persistence that uses `listen()` pins one connection for notifications, so it
needs one more than the figures above.
