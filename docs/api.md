---
title: "API"
description: "The public createCopilotz factory, its embedded, Gateway and Worker roles, the operation methods each role returns, and the package entrypoints."
section: Reference
order: 20
status: stable
---

# API

## The pain

Your Notes application works, and now a second program needs to drive it: a
support script that resubmits a failed capture, a dashboard that lists recent
operations, a deployment that splits admission from execution. Each of them
starts by asking the same questions. Which object do I create? Which methods
does it give me? When is the work I submitted actually finished? Guessing wrong
is expensive: a retry without the original identity starts a second operation,
and treating "the replay ended" as "the work succeeded" hides failures.

## The problem

The runtime exposes one factory and a small operation surface, but each method
has an ownership and settlement contract that its signature does not show:

- which role owns execution, the database and `close()`;
- what an admission identity guarantees when the same input is sent twice;
- what `done` means on a send handle versus an attachment;
- which methods are local observation and which change durable state;
- which entrypoint owns each family of declarations, and which ones depend on a
  host capability.

## The solution

### One factory, three roles

`createCopilotz(options)` from `@copilotz/copilotz` is the only application
factory. Its `role` option selects what the returned object can do:

| `role`                  | Returns                         | Owns                                         |
| ----------------------- | ------------------------------- | -------------------------------------------- |
| omitted or `"embedded"` | operation surface plus `fetch`  | a private in-process Gateway and Worker      |
| `"gateway"`             | operation surface plus `fetch`  | admission and placement over `transports`    |
| `"worker"`              | `{ ready, closed, close }` only | execution of deliveries placed on its worker |

Every role accepts the same composition: `namespace`, `plugins`, `resources`,
`adapters`, `assets` and persistence options (`database`, or a shared
`persistence` created by `createCopilotzPersistence()`). The creator of a shared
persistence facade closes it after closing the roles that use it. Role placement
is covered in
[Deploy and scale](getting-started/part-5-operate-and-scale/21-deploy-and-scale.md).

A Worker result has no operation methods. Await `worker.ready` before relying on
it, observe `worker.closed` for an unexpected stop, and call
`worker.close(reason)` on shutdown.

On every role, `close()` releases the resources that result owns locally. It
does not drain outstanding durable work. Before closing, a host awaits the
operations it chose to finish within its grace window; recorded deliveries that
are still unfinished resume on the next process that opens the same database.
See
[Deploy and scale](getting-started/part-5-operate-and-scale/21-deploy-and-scale.md).

### The operation surface

The embedded and Gateway results share the public `CopilotzApplication` type
from `@copilotz/copilotz/application`, plus `fetch`:

| Method                                                   | Purpose                                                                              |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `actions.<alias>(input, options?)`                       | Admit an Action, wait for settlement and return its recorded output                  |
| `collections.<alias>.get/list/queries/aggregate(...)`    | Read Collections without admitting an operation                                      |
| `collections.<alias>.create/update/delete/commands(...)` | Admit one Collection mutation, wait and return its recorded result                   |
| `send(input)`                                            | Admit one input envelope; returns an `ApplicationSendHandle`                         |
| `attach({ operationId, cursor? })`                       | Replay recorded history and follow a durable operation                               |
| `operationStatus({ operationId })`                       | Recorded `state`, or `null` when this namespace has no such operation                |
| `listOperations(input?)`                                 | Filter by `operationIds`, `states`, `metadata`, `limit`                              |
| `operationCheckpoint(input)`                             | Keeps the supplied Event baseline and skips sealed streams; does not take a snapshot |
| `cancelOperation({ operationId, reason? })`              | Explicit, durable cancellation                                                       |
| `maintenance(options?)`                                  | Bounded delivery, Asset, Body and operation-catalog maintenance                      |
| `observe()`                                              | Live outputs of this process, independent of any one operation                       |
| `close(reason?)`                                         | Idempotent shutdown of what this result owns                                         |
| `fetch(request)`                                         | The `/api` boundary when `serverPlugin` is composed; otherwise `404`                 |

Operation `state` is one of `accepted`, `running`, `completed`, `failed` or
`cancelled`. Every scoped method also accepts `namespace` and `databaseSchema`;
omitting them uses the application's defaults. The result never exposes the
engine, raw Collections, deliveries or configuration. Use `collections.<alias>`
reads for Collection state and `attach` or `observe` for Events.

### Trusted host calls

Use `app.actions.<alias>` when a script, test, seed or admin task already knows
which Action to run. Use `app.collections.<alias>` for a direct Collection
mutation; put business rules or multi-record transactions in an Action and call
that Action instead. Prefer `send` plus a Processor when the input is an Event
that plugins should react to, or when the caller needs an admission handle and
its progressive outputs.

| Call                                                                    | Result                                               |
| ----------------------------------------------------------------------- | ---------------------------------------------------- |
| `app.actions.<alias>(input, options?)`                                  | Recorded Action output                               |
| `app.collections.<name>.get({ id }, options?)`                          | Record or `null`                                     |
| `app.collections.<name>.list(query?, options?)`                         | Records matching a Collection query                  |
| `app.collections.<name>.queries.<query>(input?, options?)`              | Named query results, with declared schema validation |
| `app.collections.<name>.aggregate(query, options?)`                     | Aggregate rows                                       |
| `app.collections.<name>.create(input, options?)`                        | Stored record                                        |
| `app.collections.<name>.update({ id, set?, unset? }, options?)`         | Stored record                                        |
| `app.collections.<name>.delete({ id }, options?)`                       | `{ id, deleted: true }`                              |
| `app.collections.<name>.commands.<command>({ id, ...input }, options?)` | Stored record                                        |
| `app.collections.<name>.search(query, options?)`                        | Records matching a Collection search                 |
| `app.collections.<name>.relations.list(query?, options?)`               | Collection graph relations                           |

`app.actions` and `app.collections` are plain, enumerable maps with no inherited
properties. `Object.keys` lists the registered caller-facing aliases, matching
`context.actions` and `context.collections`. Stable Action IDs and Collection
storage names are not additional keys. Internal Actions such as `serverInvoke`
are excluded. Unknown aliases, commands and queries are absent properties;
attempting to call them throws a `TypeError` without admitting an operation.
Each Collection also exposes the scoped `definition` descriptor.

The factory preserves composed Action inputs/outputs and Collection aliases,
insert types and record types, including plugin dependencies and contributions.
Get/list/search also preserve the Collection content-selection overloads.
Widened composition declarations retain dynamic entries. Named commands and
queries remain dynamic because `defineCollection` erases their literal names and
input/output types; their schemas are checked at runtime. Collection insert
types use `$inferInsert`, whose required fields are not relaxed by runtime
`defaults`.

The method shapes match calls inside Actions and Processors. The operation
boundary differs: `context.collections.note.create(input, { operationKey })`
writes within the current delivery and operation; the host's
`app.collections.note.create(input, { idempotencyKey })` admits its own recorded
operation. Likewise, `context.actions.saveNote(input, { operationKey })` runs
within the current delivery, while
`app.actions.saveNote(input, { idempotencyKey })` admits a new operation.

Every call accepts `namespace` and `databaseSchema` in its final options. They
default to the application's scope; a namespace is required. Reads also accept
Collection read options, including content resolution and cancellation; named
queries, aggregates and relation reads accept a `signal`. These are ordinary
Collection reads, with the same query language and limits, and create no
operations.

Action and mutation options also accept `idempotencyKey`, `correlationId`,
`causationId`, Event `metadata` and trusted `operationMetadata`. Actions add
`actionMetadata`, delivered to `context.action.metadata` with the same ingress
provenance as an HTTP route call. Action metadata and Event metadata are
separate. These methods are trusted, like `send`: no HTTP `authorize` or
exposure policy applies and `serverPlugin` is not required.

An omitted key starts fresh work. With a key, the default correlation is stable;
repeat the same call and options to restore its recorded result, even after a
restart. Reusing a key with changed input or metadata rejects. Keys are shared
across host Action and mutation calls within one namespace and physical schema,
so use a distinct key for each intended operation. HTTP keys and host keys have
separate admission identities.

Actions and mutations each admit **one recorded operation**, using the same
protected ingress, delivery execution and result recovery as HTTP. Invalid
Action input is rejected before admission and before any `<id>.*` lifecycle
Event. Collection input and the final stored record are schema-checked; a failed
mutation appends no Collection change Event. Successful writes append the
Collection's usual Events, including command Events, inside the admitted
operation.

The returned Promise waits for inherited work to settle, then reads the
immutable result; it does not return `operationId`, `outputs` or `done`. Target
Action failure rejects, including on replay. To inspect an operation, supply
distinctive `operationMetadata`, find it with `listOperations({ metadata })`,
then use `attach` or `operationStatus`. Use `observe()` for live application
outputs.

Both embedded and Gateway handles provide these methods. A Gateway admits and
reads; Workers execute its Action and mutation deliveries through the usual
transport. The Worker factory result remains `ready`, `closed` and `close` and
does not admit work, just as it has no `send`.

### Admission and settlement

`send()` takes a `CopilotzInputEnvelope`: `type`, optional JSON `payload`,
`correlationId`, `causationId`, `deduplicationId`, `metadata`, trusted
`operationMetadata` that host policy may use for ownership, and optional
`namespace` and `databaseSchema` that default to the application's scope. This
is trusted ingress: the host chooses those scopes. Never let a public client
choose the authoritative tenant or schema. It resolves once the input is durably
admitted, with `operationId`, `eventId`, `correlationId`, `replayCursor`, an
`outputs` stream and `done`.

- **Retries.** Resend the full original request, including both `correlationId`
  and `deduplicationId`. Omitting the correlation generates a new identity,
  which conflicts with a reused deduplication ID. An identical second send
  observes live outputs; `attach` replays recorded history.
- **`send.done`** rejects when the operation fails or is cancelled.
- **`attach.done`** resolves when the replay reaches _any_ terminal state. Check
  the final `operation.failed` or `operation.cancelled` output, or
  `operationStatus`, before treating an attached operation as successful.
- **Outputs and `done` run together.** Read `outputs` concurrently with awaiting
  `done`, and cancel byte streams you do not consume.
- **`detach()`** stops only that local observer. `cancel()` and
  `cancelOperation()` change durable state; network transports map a disconnect
  to detach and reserve cancellation for an explicit, authorized Stop.

`done` covers runtime settlement, not semantic success. With the optional agent
harness, an `llm.call.failed` event can coexist with a completed operation, so
chat readers inspect model failure separately.

### Worked example: resubmit and inspect

Prerequisites: the Notes application from
[Persist and recover](getting-started/part-2-verify-and-recover/07-persist-and-recover.md),
with `composition.ts` and `notes-plugin.ts`, and `@copilotz/copilotz@^0.87.1`.

### Create `operations.ts`

`operations.ts` is an **entrypoint**. It admits one capture with a stable
identity, settles it, then reads the recorded status and recent operations. It
imports only the runtime root and `composition.ts`; it never imports
`@copilotz/copilotz/core`. Run it twice: the second run is a retry of the same
request, not a second note.

```ts
// Runtime factory and the guard that separates byte streams from Events.
import { createCopilotz, isStreamOutput } from "@copilotz/copilotz";
// Type of each item an operation emits.
import type { ApplicationOutput } from "@copilotz/copilotz";
// The host's shared choices: tenant, persistent database and plugins.
import { database, namespace, runtimePlugins } from "./composition.ts";

// Prints Event types and releases byte streams this script does not read.
async function drain(
  outputs: ReadableStream<ApplicationOutput>,
): Promise<void> {
  for await (const output of outputs) {
    if (isStreamOutput(output)) {
      await output.payload.cancel();
      continue;
    }
    console.log(`${output.durable ? "event" : "live"} ${output.type}`);
  }
}

const app = await createCopilotz({
  namespace,
  database,
  plugins: runtimePlugins,
});

try {
  // A retry must resend this whole request, so both identities are fixed
  // by the caller instead of generated per process.
  const handle = await app.send({
    type: "notes.capture.requested",
    payload: { text: "Prepare the release." },
    correlationId: "release-notes-1",
    deduplicationId: "release-notes-1:capture",
  });
  console.log(`operation ${handle.operationId}`);

  // Consume outputs while waiting; `done` rejects if the operation fails.
  const [drained, settled] = await Promise.allSettled([
    drain(handle.outputs),
    handle.done,
  ]);
  if (drained.status === "rejected") throw drained.reason;
  if (settled.status === "rejected") throw settled.reason;

  // The durable record, independent of this process's observation.
  const status = await app.operationStatus({
    operationId: handle.operationId,
  });
  console.log(`status ${status?.state ?? "unknown"}`);

  // Recent completed operations in this namespace.
  const recent = await app.listOperations({ states: ["completed"], limit: 5 });
  for (const operation of recent) {
    console.log(
      `completed ${operation.operationId} at ${operation.completedAt}`,
    );
  }
} finally {
  // Release the database even after a failure.
  await app.close();
}
```

Expected facts: the first run prints `notes.capture.requested`, `note.created`,
`notes.save.completed` and `status completed`. A second run with the same
`./data` reports the same operation ID instead of creating another note.

## Reference

### Generic ingress versus schema-aware HTTP

`app.send()` is generic, trusted, in-process ingress: it accepts any input type
and stores its payload as given. It performs no caller authentication. `fetch`
is different. It serves only what `serverPlugin` exposes and validates requests
against declared Action, Collection and Channel schemas. Identity is the host's
choice: the server's `authenticate` and `authorize` hooks are optional, and
without them requests run in the application's default scope with no
constraints. Enabling `serverPlugin` alone installs no login and no tenant
isolation. The host configures both, as shown in
[Authenticate and isolate tenants](getting-started/part-4-release-to-users/16-authenticate-and-isolate-tenants.md).
See [HTTP server and browser client](server.md).

Over HTTP, `client.operations.result` and `client.actions.invoke` return the
target Action's output once that Action is ready. They do not wait for
descendant work or an agent reply: `sendConversation` returns
`{ threadId, message }` once the message is stored, which can happen before the
model produces output. Observe the terminal operation state when you need full
completion.

### Package entrypoints

The same public imports work on Deno and Node. Native host entrypoints use
filesystem, subprocess, terminal or listener APIs, so browsers and Workers
cannot use them. Portable adapters run anywhere because the host supplies their
I/O.

| Entrypoint                                                                                                                                       | Contents                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `@copilotz/copilotz`                                                                                                                             | `createCopilotz`, persistence, Actions, Collections, Events, Processors, plugins, content, streams, `secret` |
| `/application`                                                                                                                                   | Operation surface types only, no factory                                                                     |
| `/actions`, `/collections`, `/collections/authoring`, `/events`, `/plugins`, `/content`, `/content/codec`, `/streams`, `/engine`, `/persistence` | Focused runtime subpaths                                                                                     |
| `/server`, `/client`                                                                                                                             | Server plugin and Fetch facade; typed browser client                                                         |
| `/core`, `/core/server`, `/core/client`                                                                                                          | Optional agent harness, its HTTP routes and client                                                           |
| `/llm`, `/llm/tokens`, `/memory`, `/knowledge`, `/goals`, `/skills`, `/transcription`                                                            | Agent capabilities                                                                                           |
| `/tools/builtin`, `/tools/openapi`, `/tools/mcp`, `/tools/web`, `/tools/finance`, `/tools/persistent-terminal`                                   | Tool integrations                                                                                            |
| `/channels`, `/channels/core`, `/schedules`, `/schedules/core`, `/usage`, `/usage/client`, `/admin`                                              | Delivery and operations plugins                                                                              |
| `/build`                                                                                                                                         | Filesystem authoring build                                                                                   |
| `/core/cli`                                                                                                                                      | Portable CLI adapter; the host supplies input and output                                                     |
| `/adapters/deno`, `/core/cli/node`, `/skills/deno`, `/tools/deno`, `/tools/mcp/stdio`, `/tools/persistent-terminal/deno`                         | Native host: listeners, terminals, local files, subprocesses                                                 |

Protected Action values (`secret`, Secret Adapters) are covered in
[Actions](actions.md).

## What this unlocks

You can write support scripts, dashboards and hosts against one factory, pick a
role deliberately, retry admission without duplicating work, and tell runtime
settlement apart from domain or model success.

## Next steps

- [Persist and recover](getting-started/part-2-verify-and-recover/07-persist-and-recover.md)
- [Events, deliveries and recovery](events-deliveries-recovery.md)
- [HTTP server and browser client](server.md)
- [Deploy and scale](getting-started/part-5-operate-and-scale/21-deploy-and-scale.md)
