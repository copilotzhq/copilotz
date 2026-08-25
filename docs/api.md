# API and Package Reference

## One application factory

`createCopilotz()` is the only public application factory. Its `role` option is
discriminated:

```ts
import { createCopilotz } from "@copilotz/copilotz";

const embedded = await createCopilotz({ namespace: "acme", plugins });
const gateway = await createCopilotz({
  role: "gateway",
  namespace: "acme",
  plugins,
  transports,
  target: { workerId: "acme-worker" },
});
const worker = await createCopilotz({
  role: "worker",
  namespace: "acme",
  plugins,
  id: "acme-worker",
  transport,
});
```

Omitting `role` selects the embedded topology. It owns a private in-process
Gateway and Worker unless the caller injects database or dispatch
infrastructure. Gateway and Worker options use the same plugin, resource,
adapter, asset, and persistence configuration; `Gateway` adds dispatch/transport
placement and `Worker` adds the Oxian worker connection options.

## Returned role surfaces

The embedded application has exactly:

```ts
{
  send, observe, close;
}
```

Gateway returns that same base surface plus `fetch(request)`. Worker returns
only `{ ready, closed, close }`. Neither result exposes configuration, database
scopes, collections, content, events, deliveries, plugins, recovery, an Engine,
or a shutdown alias.

`send()` returns a stable operation handle:

```ts
type ApplicationSendHandle = Readonly<{
  eventId: string;
  correlationId: string;
  outputs: ReadableStream<ApplicationOutput>;
  done: Promise<void>;
  cancel(reason?: string): Promise<void>;
}>;
```

`observe()` receives the same application outputs independently of any one
operation. Normal Events retain their immutable envelope and add deeply frozen
resolved `data`; durable Events keep their original `payload.dataRef`.
Progressive `stream.output` values remain subscriber-owned byte streams.
`close()` is idempotent.

## Gateway Fetch

`gateway.fetch` is the portable event-native HTTP boundary, rooted at `/v3` by
default. Gateway options may provide `http` options and a trusted
`resolveDatabaseSchema(request)` callback. The resolver is the physical-schema
authorization boundary; request context cannot override it.

The Deno listener accepts any structural Fetch-capable host:

```ts
import { listen } from "@copilotz/copilotz/adapters/deno";

const listener = listen(gateway, { hostname: "0.0.0.0", port: 8080 });
```

## Persistence

`@copilotz/copilotz/persistence` is the explicit persistence contract subpath.
It exports Ominipg connection options plus `createCopilotzPersistence()` for an
application that deliberately shares one reconnectable database facade across
several internal roles. The public application factory accepts that facade in
its `persistence` option; its creator retains the final `close()` ownership.

## Explicit primitive and plugin packages

The root exports only `createCopilotz`, `CreateCopilotzOptions`, and generic
application/operation types. Import reusable primitives from their deliberate
subpaths: `/actions`, `/collections`, `/content`, `/events`, `/plugins`, and
`/persistence`. Import semantic composition from plugin packages such as
`/core`, `/llm`, `/channels`, `/knowledge`, `/schedules`, and `/usage`.

`/application` exports generic application types only; it does not expose a
factory or runtime authority. `/server` remains an explicit server-projection
package for host integrations, not a backdoor to runtime internals.

Host-specific entrypoints are `/adapters/deno`, `/core/cli`, `/core/cli/node`,
`/skills/deno`, `/tools/deno`, `/tools/mcp/stdio`, and
`/tools/persistent-terminal/deno`. There are no generic `/adapters`,
`/adapters/node`, `/domain`, or `/attachments` subpaths.

The sole database upgrade is `/migration/v4#migrateToV4`, restricted to the
exact Copilotz 0.47/0.48 legacy graph profile. See
[the migration guide](migration-v4.md).
