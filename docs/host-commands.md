---
title: "Trusted Host Commands"
description: "Run fixed-scope host SQL through the existing owner, with atomic receipts and explicit startup recovery."
section: Operate
order: 45
status: stable
---

# Trusted Host Commands

## The pain

A host-owned service needs a small SQL mutation alongside the runtime. Retrying
an interrupted request can repeat the write, and a startup that opens only the
default schema can leave another configured schema's overdue work idle.

## The problem

SQL authority belongs to the database owner. A command must use that owner's
queue, transaction fence and recovery lifecycle. Its caller must not choose a
new principal or scope by changing request data. Durable replay also needs the
original input and result, committed with the mutation.

## The solution

Register trusted local callbacks with `hostCommands`, then call
`app.hostCommands.invoke(name, input, { idempotencyKey })`. Embedded and Gateway
applications expose this surface. Workers reject both `hostCommands` and
`databaseScopes`; neither option, SQL callbacks nor command handles enter worker
contexts, transport messages or automatically generated HTTP routes.

### Create `host.ts`

This host composition module accepts a database from its caller and chooses no
persistent path. Install the package using the
[setup guide](getting-started.md#before-you-start). The example works in Deno
and Node with the host prerequisites described in
[Runtimes and Host Capabilities](runtime-adapters.md).

```ts
import { createCopilotz } from "@copilotz/copilotz";
import type { CopilotzDatabaseInput } from "@copilotz/copilotz/persistence";

export function createNotesHost(database: CopilotzDatabaseInput) {
  return createCopilotz({
    database,
    hostCommands: {
      saveNote: {
        // These identify a trusted service and fixed data scope, not an end user.
        databaseSchema: "public",
        namespace: "notes",
        principal: "notes-host",
        authorize(input: { id: string; text: string }) {
          // The embedding HTTP/session boundary must authenticate its own user.
          if (
            !input.id || input.id.length > 100 || input.text.length > 10_000
          ) {
            throw new TypeError("Invalid note.");
          }
        },
        async execute(input: { id: string; text: string }, context) {
          // This application-owned table is created and written in the owner command.
          await context.query(`CREATE TABLE IF NOT EXISTS public.host_notes (
            namespace TEXT NOT NULL, id TEXT NOT NULL, text TEXT NOT NULL,
            PRIMARY KEY (namespace, id)
          )`);
          await context.query(
            `INSERT INTO public.host_notes(namespace,id,text) VALUES($1,$2,$3)
             ON CONFLICT(namespace,id) DO UPDATE SET text=EXCLUDED.text`,
            [context.scope.namespace, input.id, input.text],
          );
          return { id: input.id, text: input.text };
        },
      },
    },
  });
}
```

### Create `save-note.ts`

This entrypoint takes its varying values from command-line arguments. Its
private in-memory database is disposable; an embedding host supplies its
configured persistent database to `createNotesHost` instead.

```ts
import { argv } from "node:process";
import { createNotesHost } from "./host.ts";

const [id, text, idempotencyKey] = argv.slice(2);
if (!id || !text || !idempotencyKey) {
  throw new Error("Usage: save-note.ts <id> <text> <idempotency-key>");
}
const app = await createNotesHost({ url: ":memory:" });
try {
  const saved = await app.hostCommands.invoke("saveNote", { id, text }, {
    idempotencyKey,
  });
  // Repeating this same invocation in this database returns the recorded result.
  console.log(saved);
} finally {
  await app.close();
}
```

Run `deno run -A save-note.ts note-1 hello request-1` or
`node save-note.ts note-1 hello request-1`. The result is
`{ id: "note-1", text: "hello" }`. A new run with the demonstrated in-memory
configuration opens a new database and therefore has no receipts from an earlier
process.

## Reference

- Every registration requires `namespace`, `principal`, `authorize` and
  `execute`. `databaseSchema` defaults to the application's configured schema.
  Registrations are fixed for the lifetime of that application.
- `authorize` is the policy/read phase. Keep mutations in `execute`, because
  authorization runs again before receipt replay. Return normally to permit the
  call or throw to reject it.
- `principal` identifies the trusted host service. It does not authenticate an
  HTTP caller, session or end user. The embedding host owns those policies.
- Both callbacks receive `query(sql, params?)`, fixed `scope`, `commandTime`,
  `signal` and `afterCommit(callback)`. The query-only context can also be
  passed to supported public provisioning helpers such as `provisionNodeIndex`,
  `provisionCoreHistoryIndexes` and `provisionVectorStorage`; they join this
  command without opening another transaction or retaining another owner.
- Query and publication handles reject after their callback completes or fails,
  or when the application/owner is cancelled. Do not retain them. Queries
  started inside a callback are drained before it completes. Keep callbacks
  short and honor the signal; an owner serializes commands for its schema.
- Scope metadata does not confine arbitrary trusted SQL. Callbacks must use
  explicit schema and namespace predicates, parameterize values, and leave
  transaction control to the owner. SQL authority makes these host-only
  callbacks unsuitable for code supplied by untrusted users or workers.
- Input is validated, copied and deeply frozen synchronously before admission
  waits. Input and output must be finite JSON, at most 1 MiB, 100,000 nodes and
  64 levels deep. Accessors, functions, cyclic data and non-JSON prototypes are
  rejected. Output is copied and frozen before committing, including on calls
  without an idempotency key; invalid output rolls back the mutation.
- An idempotency key is scoped by database schema, namespace, command name and
  principal using an unambiguous tuple. The receipt binds the complete canonical
  input. Changing that input for an existing identity rejects the call.
  `authorize` runs inside the fenced command even for a receipt replay.
- Mutation and validated result receipt commit atomically. An unknown commit
  revokes the owner. After reacquiring ownership, retry the same command and key
  to read its receipt; never invent a new key to resolve an uncertain outcome.
  Calls without a key have no replay guarantee and are appropriate for reads
  that must see current data.
- `afterCommit` publishes only after confirmed commit. It is a local callback,
  not a durable external-effect delivery guarantee; use the Action effect
  protocol for durable external effects.

### Explicit startup scopes

`databaseScopes: ["archive", "workspace"]` requests activation of those
pre-provisioned schemas through the ordinary application database-scope path.
The list is validated and deduplicated; every fixed host-command schema is
included automatically. Non-default schemas must already have the required
schema, catalog and collection indexes. This option does not enumerate database
schemas, provision missing schemas or grant a worker database access.

The factory resolves after requested owners are ready and their recovery sweep
has run. Due work may still be executing; readiness does not promise its
completion. A partial startup failure closes opened attachments and recovery
resources without deleting retained data. Omitting both options preserves the
normal lazy scope behavior.

`HostCommandDefinition`, `HostCommandContext`, `HostCommandJson`,
`HostCommandDefinitions`, `HostCommandOptions` and `HostCommands` are exported
from the root package and `@copilotz/copilotz/application`. Literal registration
maps preserve command names and callback input/output inference. Runtime JSON
validation remains authoritative even when a callback is declared to return
`unknown`.

## What this unlocks

Trusted host services can keep small data commands and explicit schema recovery
inside the runtime's existing ownership boundary, with retry behavior that can
be checked against committed receipts.

## Next steps

- [Deployment Topologies](embedding-and-hypervisors.md) explains owner/worker
  placement.
- [API](api.md) covers ordinary Action, Collection and operation calls.
- [Upgrading and Data Safety](upgrading.md) covers explicit provisioning and
  retained data.
