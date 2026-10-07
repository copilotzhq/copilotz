---
title: "Chapter 7: Persist and Recover"
description: "Keep notes and their Event history on local disk by changing one database choice, then reopen the application in a new process and replay an earlier operation by its ID."
section: Getting Started
order: 70
status: stable
---

# Chapter 7: Persist and Recover

> Part 2 — Verify and Recover · Track: R · Requires: Chapter 5 (Chapter 6
> recommended) · Needs: Deno 2.9+ or Node 24+ (no credential)

## The pain

Every time `app.ts` exits, Notes forgets everything. The note you saved, the
`notes.save` lifecycle that recorded it and the operation's `completed` state
all live in a private in-memory database, and `app.close()` throws that database
away. `app.ts` prints an operation ID, but no later process can do anything with
it: by the time you could ask about it, the operation no longer exists.

The same loss hides a worse problem. If the process stops while a delivery is
still running, for example because the host restarts it, that unfinished work
vanishes too. Nothing is left to say that a capture request was accepted but its
note was never saved.

## The problem

Recovery needs **durability**: the accepted request, its pending deliveries, the
Events they record and the operation's state must outlive the process that
created them. A new process must then be able to find that same state and pick
it up.

That only works if the new process opens _the same_ application:

- the same database, at the same location;
- the same namespace, because operations and records are looked up within it;
- the same plugin, with the same stable IDs, because stored Events and
  deliveries name the `note` Collection, the `notes.save` Action and the
  `notes.capture` Processor by those IDs.

Durable work also runs **at least once**. A delivery that was interrupted may
run its Processor again, so the effects it repeats must resolve to what was
already stored instead of storing it twice.

## The solution

Change the shared database choice from the in-memory default to a database on
local disk, and read earlier operations back by their ID with two public calls:

- `app.operationStatus({ operationId })` returns the operation's recorded state,
  or `null` when this namespace has no such operation.
- `app.attach({ operationId })` returns an **attachment**: `outputs` replays the
  operation's recorded Events from its start, and keeps following it if it is
  still running. `done` resolves once the operation has reached a final state.

Attaching only reads. It records nothing, and it never runs the `notes.capture`
Processor again. A finished operation's replay ends with one output that is not
stored, `operation.completed` (or `operation.failed` or `operation.cancelled`),
that reports the final state.

Copilotz on Deno and Node opens the local database with PGlite, which stores it
in a directory. On Node, the setup step already installed
`@electric-sql/pglite`, so this chapter needs no new package and no credential.

### Edit `composition.ts`

`composition.ts` stays a **host composition module**. This step replaces one
whole entry: the `database` value changes from `{ url: ":memory:" }` to
`{ url: "file://./data" }`. `namespace` and `runtimePlugins` are unchanged, so
every entrypoint that imports them keeps the same tenant and the same stable
Notes IDs. Tests are unaffected: they never import `composition.ts` and keep
their private in-memory databases.

The complete updated file:

```ts
// The database options type, so a mistyped option fails type-checking here
// rather than at startup.
import type { CopilotzOminipgOptions } from "@copilotz/copilotz";
// The reusable Notes package. The application composes it; it does not copy it.
import { notesPlugin } from "./notes-plugin.ts";

// Tenant namespace recorded on every Event and record this application owns.
// It is the application's choice, so the plugin does not declare one. Keep it
// unchanged between runs: operations and records are looked up within it.
export const namespace = "team-notes";

// The database that the Notes host entrypoints open: a local PGlite database
// stored in the `data` directory. Unlike the in-memory default, it survives
// `close()` and process exit, so a later process finds the same notes, Events
// and operations.
export const database: CopilotzOminipgOptions = { url: "file://./data" };

// Runtime plugins this application composes, in order. Later chapters append to
// this list, so each Notes entrypoint gains new behaviour without dropping it.
export const runtimePlugins = [notesPlugin];
```

`app.ts` needs no change. It already passes `database` from `composition.ts` to
`createCopilotz`, so its next run stores everything in `./data`. The first start
against a new directory creates the database and its schema; later starts
validate that schema and reuse it.

Treat `./data` as disposable development state: keep it out of version control,
and do not open it from two processes at once. It is one local directory for one
process on one machine, not storage that several hosts can share.

### Create `recover.ts`

`recover.ts` is an **entrypoint**. It takes an operation ID from the command
line, opens the application with the same shared choices as `app.ts`, reports
the operation's recorded state, and replays its history. Its local imports are
`composition.ts` and, through it, `notes-plugin.ts`; it never imports
`@copilotz/copilotz/core`.

It prints only the facts it needs: Event types, IDs and positions, plus the ID
and text of the saved note. A replay returns each Event's complete recorded
data, including Action inputs, so a recovery tool should not dump whole payloads
into logs where they would expose values that callers sent.

```ts
// Runtime factory and the guard that separates byte streams from Events.
import { createCopilotz, isStreamOutput } from "@copilotz/copilotz";
// Type of each item an attachment replays.
import type { ApplicationOutput } from "@copilotz/copilotz";
// The same shared choices as `app.ts`: namespace, database and plugins.
import { database, namespace, runtimePlugins } from "./composition.ts";
// The operation ID comes from the command line.
import { argv } from "node:process";

// Require the ID before opening the database, so a missing argument fails
// without starting the runtime.
const operationId = argv[2];
if (!operationId) {
  throw new Error(
    "Pass the operation ID that app.ts printed: recover.ts <operation-id>",
  );
}

// The two note fields this script prints. Event data is `unknown` at run time,
// so each value is checked before it is used.
type SavedNote = Readonly<{ id: string; text: string }>;

// Reads one field of an object, or nothing when the value is not an object.
function field(data: unknown, key: string): unknown {
  return typeof data === "object" && data !== null
    ? (data as Record<string, unknown>)[key]
    : undefined;
}

// A stored note, or undefined when the value does not have a note's shape.
function savedNote(value: unknown): SavedNote | undefined {
  const id = field(value, "id");
  const text = field(value, "text");
  return typeof id === "string" && typeof text === "string"
    ? { id, text }
    : undefined;
}

// Prints the replayed history, in the order it arrives.
async function printReplay(
  outputs: ReadableStream<ApplicationOutput>,
): Promise<void> {
  for await (const output of outputs) {
    // Notes opens no byte streams. Release any that appear so they do not hold
    // the attachment open.
    if (isStreamOutput(output)) {
      await output.payload.cancel();
      continue;
    }
    // Recorded Events, read back from the database by their stable IDs.
    if (output.durable) {
      const line =
        `event ${output.type} id=${output.id} position=${output.position}`;
      // The stored note: the `record` of `note.created`, or the `output` that
      // `notes.save` returned on `notes.save.completed`.
      const note = output.type === "note.created"
        ? savedNote(field(output.data, "record"))
        : output.type === "notes.save.completed"
        ? savedNote(field(output.data, "output"))
        : undefined;
      console.log(
        note
          ? `${line} note=${note.id} text=${JSON.stringify(note.text)}`
          : line,
      );
      continue;
    }
    // Not stored: the final `operation.*` output that reports how the
    // operation ended.
    console.log(`live ${output.type} data=${JSON.stringify(output.data)}`);
  }
}

// Open the same application as `app.ts`. Startup validates the stored schema
// and resumes any unfinished deliveries it finds.
const app = await createCopilotz({
  // Operations are looked up within this namespace.
  namespace,
  // The persistent database from `composition.ts`.
  database,
  // The same plugins, so stored IDs match registered declarations.
  plugins: runtimePlugins,
});

try {
  // Read the recorded state first. `null` means this namespace and database
  // hold no operation with that ID.
  const status = await app.operationStatus({ operationId });
  if (!status) {
    throw new Error(`Operation ${operationId} was not found in ${namespace}.`);
  }
  console.log(`found operation ${operationId}: ${status.state}`);

  // Replay the operation's recorded Events from its start. If it is still
  // running, keep following it until it reaches a final state.
  const attachment = await app.attach({ operationId });
  // Read outputs while waiting for `done`, so the replay can make progress.
  // Wait for both before cleanup, even if either fails.
  const [drained, settled] = await Promise.allSettled([
    printReplay(attachment.outputs),
    attachment.done,
  ]);
  if (drained.status === "rejected") throw drained.reason;
  if (settled.status === "rejected") throw settled.reason;

  // Read the state again after the replay ended.
  const after = await app.operationStatus({ operationId });
  console.log(
    `replayed operation ${operationId}: ${after?.state ?? "unknown"}`,
  );
} finally {
  // Release the database, including after a failure, so the next process can
  // open it.
  await app.close();
}
```

When the ID is missing, the script throws before opening the database. When the
ID is unknown, `operationStatus` returns `null`, and the script throws its own
error once `finally` has closed the application. Calling `app.attach` directly
with an unknown ID rejects with an error whose `code` is `operation_not_found`.
If the replay itself fails, `attachment.done` rejects. Each case exits with a
non-zero status. An operation that ended as `failed` still replays: its last
output is `operation.failed`, and the final status line reports `failed`. The
two `done` promises mean different things: a send handle's `done` rejects when
the operation fails, but an attachment's `done` resolves once the replay reaches
any final state, so check the final `operation.failed` or `operation.cancelled`
output, or `operationStatus`, before treating an attached operation as
successful.

### How recovery uses stable keys

Persistence is what makes interrupted work recoverable. When a process stops
before a delivery finishes, the delivery stays recorded. The next application
that opens the same database, namespace and plugins picks it up again: at
startup for a delivery nobody holds, or once the stopped process's lease on it
expires. The Processor then runs again for the same delivery, and `recover.ts`
follows the operation until it ends.

Because a delivery can run more than once, Chapter 4's operation keys are what
keep the repeat safe. `notes.capture` calls `saveNote` with the key
`save-request`, and `notes.save` writes the note with
`${context.operationKey}:save-note`. On the second run, both resolve to the
results already recorded, so the delivery completes with the original note
instead of a second one. That guarantee covers Collection writes and Action
calls that Copilotz records. A call to a remote service, such as a payment or
email API, is outside it: pass that service its own idempotency key, derived
from the same stable identity, when it supports one.

Two kinds of identity are easy to confuse:

- **`deduplicationId`** belongs to admission. It lets a client resend one
  complete `app.send` input, including the same `correlationId`, and get the
  original operation back instead of a new one. Chapter 6 tests it.
- **`operationKey`** names one Action call or Collection write inside a
  delivery. It is what makes a recovered delivery reuse stored results.

Recovery relies on operation keys; `app.ts` needs no `deduplicationId` for it.

Observing and changing an operation are also different. `attachment.detach()`
stops only this observer and leaves the operation untouched; closing the
application does the same. Cancelling, through `app.cancelOperation` or a send
handle's `cancel()`, records a durable change to the operation's state. The
[Events, Deliveries, and Recovery reference](../../events-deliveries-recovery.md)
covers both.

### Optional: use PostgreSQL instead

A local directory serves one process on one machine. When the host provides a
PostgreSQL server, edit `composition.ts`: insert the `env` import below the
existing imports, and replace the `database` declaration with the check and
declaration shown here. The existing `CopilotzOminipgOptions` import, the
namespace and the plugin list stay. Only host composition reads the environment,
and it checks that the value is present rather than assuming it:

```ts
// The host supplies the connection URL; no credential is written in code.
import { env } from "node:process";

// Fail at startup with a clear message when the URL is missing.
const databaseUrl = env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("Set DATABASE_URL to the PostgreSQL connection URL.");
}

// Replaces the `database` entry in composition.ts. The namespace and plugins
// stay the same.
export const database: CopilotzOminipgOptions = { url: databaseUrl };
```

Switching databases does not move data: a new database starts empty, and
operations recorded in `./data` stay there. Copilotz validates the schema at
startup and provides no automatic data migration.
[Chapter 21: Deploy and Scale](../part-5-operate-and-scale/21-deploy-and-scale.md)
covers shared databases, several processes and where large content is stored.

## Check it works

Choose one runtime and use it for both commands. Run them one after the other,
never at the same time, and do not switch runtimes while a process has `./data`
open. Run them from the project directory, where `./data` is created.

**Deno:**

```sh
# Save a note into the local database. Note the operation ID it prints.
deno run -A app.ts "Prepare the release."
# After the first command has exited, reopen the database and replay that
# operation. Replace OPERATION_ID with the ID from the first command.
deno run -A recover.ts OPERATION_ID
```

**Node 24+:**

```sh
# Save a note into the local database. Note the operation ID it prints.
node app.ts "Prepare the release."
# After the first command has exited, reopen the database and replay that
# operation. Replace OPERATION_ID with the ID from the first command.
node recover.ts OPERATION_ID
```

The first command prints the same lines as in Chapter 5, ending with
`settled operation 3f6c…: completed`, and a `data` directory appears in the
project. The second command prints something like this. IDs, positions and
timestamps differ on every machine:

```text
found operation 3f6c…: completed
event notes.capture.requested id=3f6c… position=1
event notes.save.invoked id=7c42… position=2
event note.created id=8d2a… position=3 note=5b91… text="Prepare the release."
event notes.save.completed id=a1e0… position=4 note=5b91… text="Prepare the release."
live operation.completed data={"status":"completed"}
replayed operation 3f6c…: completed
```

Check these facts:

- `found operation` names the ID that `app.ts` printed, with state `completed`,
  before anything is replayed: the state survived the process exit.
- The `note.created` line shows the same `note=` value and text as the first
  run, and so does `notes.save.completed`. Each `event` line's `id` matches the
  first run's line for that type. These are the original records read back, not
  new writes.
- Exactly one `note.created` line appears. Reopening the database did not run
  the `notes.capture` Processor again.
- The last replayed output is `live operation.completed`, and the final line
  reports `completed`.

Run `recover.ts` with the same ID again: it prints the same Events, because
replay only reads. Run `app.ts` again, then `recover.ts` with the new ID: the
new operation's positions are higher, because the database now holds both runs.

Finally, pass an ID that does not exist, such as `recover.ts missing`. The
script reports that the operation was not found and exits with a non-zero
status.

To start again from empty state, point `database.url` at a new directory, such
as `file://./data-ch7`. The old directory stays as it was.

## What this unlocks

Notes now keeps its records, Events and operations across restarts. You can:

- stop and start the application without losing notes or their history;
- look up any earlier operation by ID with `app.operationStatus`, and replay its
  recorded Events with `app.attach`, from a different process than the one that
  started it;
- rely on unfinished deliveries resuming after a restart, with stable operation
  keys turning repeated work into the results already stored;
- switch the shared database once in `composition.ts` for every Notes
  entrypoint, while tests keep their isolated in-memory databases.

## Next steps

- Next: [Chapter 8: Hello Agent](../part-3-add-agent-behavior/08-hello-agent.md)
  starts the optional agent-harness track, the fastest route to a model reply.
- Runtime only: skip to
  [Chapter 15: Expose an HTTP API](../part-4-release-to-users/15-expose-an-http-api.md)
  to let other programs call `notes.save` over HTTP.
- Reference:
  [Events, Deliveries, and Recovery](../../events-deliveries-recovery.md)
  explains delivery states, leases, retries, cancellation and schema validation.
- Reference: [API](../../api.md) lists `operationStatus`, `attach`,
  `cancelOperation` and the other application operations.
- Later:
  [Chapter 21: Deploy and Scale](../part-5-operate-and-scale/21-deploy-and-scale.md)
  moves from one local directory to a shared database and body storage.
