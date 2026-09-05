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

The embedded application exposes the generic operation surface:

```ts
{
  send,
    attach,
    operationStatus,
    listOperations,
    cancelOperation,
    maintenance,
    observe,
    close;
}
```

Gateway returns that same base surface plus `fetch(request)`. Worker returns
only `{ ready, closed, close }`. Neither result exposes configuration, database
scopes, collections, content, events, deliveries, plugins, recovery, an Engine,
or a shutdown alias.

`send()` returns a stable operation handle:

```ts
type ApplicationSendHandle = Readonly<{
  operationId: string;
  eventId: string;
  correlationId: string;
  replayCursor: string;
  outputs: ReadableStream<ApplicationOutput>;
  done: Promise<void>;
  detach(reason?: string): Promise<void>;
  cancel(reason?: string): Promise<void>;
}>;
```

`attach({ operationId, cursor })` returns another output stream and settlement
Promise for that durable operation. Its `detach()` affects only the observer.
Network transports must map disconnect to detach and reserve `cancelOperation()`
for an authenticated, explicit Stop action. Opaque replay cursors combine
durable Event positions with per-stream byte offsets.

`observe()` receives live application outputs independently of any one
operation. Normal Events retain their immutable envelope and add deeply frozen
resolved `data`; durable Events keep their original `payload.dataRef`.
Progressive `stream.output` values remain subscriber-owned byte streams.
`maintenance()` performs bounded delivery, Asset, progressive Body, and
operation-catalog maintenance. `close()` is idempotent.

## Gateway Fetch

`gateway.fetch` serves the single `/api` boundary installed by
`createServerPlugin()`. The compiler discovers exposed Actions, Collections,
Channels and exact HTTP Adapter routes, and generates OpenAPI from that table.
`createCoreServerPlugin()` contributes conversation reads, observation and
ordinary mutation Actions. Authentication resolves trusted scope; authorization
intersects constraints before reads or execution. See
[HTTP server and browser client](server.md).

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

## Protected Action values

Use `secret(schema)` from `/actions`, or add the exact raw boolean extension
`"x-copilotz-secret": true`, at any input/output schema subtree:

```ts
import {
  createSecretAdapter,
  defineAction,
  secret,
} from "@copilotz/copilotz/actions";

const exchange = defineAction({
  id: "myapp.auth.exchange",
  inputSchema: {
    type: "object",
    properties: { code: secret({ type: "string" }) },
    required: ["code"],
    additionalProperties: false,
  },
  execute: async ({ code }) => exchangeCode(code),
});

const secretAdapter = createSecretAdapter({ seal, open });
const app = await createCopilotz({
  plugins: [authPlugin],
  adapters: { secrets: { default: secretAdapter } },
});
```

The Adapter receives bytes plus stable additional authenticated data and stays
process-local. Its ciphertext is stored through BodyStore under an internal
protected-value owner; plaintext never enters the Action Event Body or ordinary
observation. The Action still receives and directly returns the hydrated value.
Composition fails when a registered secret-bearing Action has no default Secret
Adapter. Metadata must not contain marked input values, and secret-bearing
Actions cannot emit progress until an inspectable progress schema exists.

`resolveActionSourceData(context)` is the narrow bridge helper for an Action
invoked from a protected durable source Event. It resolves only that exact
causal Event in the current namespace; it is not a general Event lookup.

## Explicit primitive and plugin packages

The root exports only `createCopilotz`, `CreateCopilotzOptions`, and generic
application/operation types. Import reusable primitives from their deliberate
subpaths: `/actions`, `/collections`, `/content`, `/events`, `/plugins`, and
`/persistence`. Import semantic composition from plugin packages such as
`/core`, `/llm`, `/channels`, `/knowledge`, `/schedules`, and `/usage`.

`/application` exports generic application types only; it does not expose a
factory or runtime authority. `/server` exports the semantic Server plugin,
route compiler, portable Fetch façade, multipart encoder/decoder, and their
contracts—not runtime storage or execution authority.

Host-specific entrypoints are `/adapters/deno`, `/core/cli`, `/core/cli/node`,
`/skills/deno`, `/tools/deno`, `/tools/mcp/stdio`, and
`/tools/persistent-terminal/deno`. There are no generic `/adapters`,
`/adapters/node`, `/domain`, or `/attachments` subpaths.

The sole database upgrade is `/migration/v4#migrateToV4`, restricted to the
exact Copilotz 0.47/0.48 legacy graph profile. See
[the migration guide](migration-v4.md).
