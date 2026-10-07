---
title: "Chapter 6: Test and Inspect"
description: "Check the Notes plugin's observable behaviour in isolated in-memory applications on Deno and Node, and use opt-in delivery diagnostics to see where a failed delivery stopped."
section: Getting Started
order: 60
status: stable
---

# Chapter 6: Test and Inspect

> Part 2 — Verify and Recover · Track: R · Requires: Chapter 5 · Needs: Deno
> 2.9+ or Node 24+ (no credential)

## The pain

So far, the only way to know that Notes works is to run `app.ts` and read its
output line by line. You compare the `note=` values by eye, count the
`note.created` lines, and send an empty note to see that the process fails.
Every change to `notes-plugin.ts` means repeating that by hand, and nothing
warns you when a later change quietly breaks one of those facts.

Some behaviour cannot be seen from `app.ts` at all. Each run sends one new
request, so it never shows what happens when a client sends the same request
twice, or when one delivery saves two notes. And when the empty note fails, you
learn only that `handle.done` rejected. You cannot tell whether the request was
never picked up, whether the Processor started and threw, or whether the runtime
will try it again later.

## The problem

Checking Notes automatically needs three things:

- **Isolation.** Each check starts from empty state, and no check can see
  another's notes, a developer's local data or a shared database.
- **Observable contracts.** Checks should test what callers rely on: the Events
  an operation records, how the operation settles, and which note a caller gets
  back. They should not depend on generated IDs, timing, error wording or how
  the runtime stores rows.
- **Visibility into deliveries.** A Processor runs in the background, on behalf
  of a delivery. When it fails, you need to see how far that delivery got and
  how it ended, without reading the runtime's storage.

## The solution

Treat `notesPlugin` as the unit under test. Each scenario composes a fresh
application around it with `createCopilotz`, drives it through the public
`app.send`, and checks the results:

- the Events it sees on `handle.outputs`, and how `handle.done` settles;
- the operation's recorded state from `app.operationStatus`;
- the operation's recorded history, replayed with `app.attach`;
- **delivery diagnostics**, reported to an `onDeliveryDiagnostic` function
  passed to `createCopilotz`.

Each scenario omits `database`, so it gets its own private in-memory database.
That database disappears when the scenario closes its application, so no
scenario sees another's notes and nothing is written to disk. The scenarios
import only `notesPlugin` and `saveNote`, never `app.ts` or `composition.ts`.
Plugins that later chapters add to the application therefore do not change what
these tests compose.

The tests check four facts:

| Scenario                                         | Fact it protects                                                        |
| ------------------------------------------------ | ----------------------------------------------------------------------- |
| A capture request saves one note                 | One request records one save, and the Action returns the note it stored |
| Repeating the same request reuses the saved note | A repeated request finds the original operation instead of a new note   |
| An empty note fails without saving               | Invalid input fails the operation and is not retried                    |
| Two saves in one delivery store two notes        | `notes.save` can be called twice in one delivery without a collision    |

### Repeated requests

`app.send` accepts an optional `deduplicationId`. If the same input is sent
again with the same `deduplicationId`, Copilotz admits the original Event
instead of recording a new one: the second call returns the original
`operationId` and `eventId`, and no new delivery runs.

"The same input" means every field that identifies the Event, including its
`correlationId`. If you omit `correlationId`, `app.send` generates a new one on
every call, so a retry that reuses only the `deduplicationId` and payload is a
_different_ Event with a reused ID, and it is rejected as a conflict. A client
that may retry should therefore build one complete input, including
`correlationId` and `deduplicationId`, and send that same input every time.

The two calls observe different things:

- `handle.outputs` carries only what happens **while you watch**. The first call
  sees its Events as they are recorded. The repeated call watches an operation
  that has already finished, so its outputs contain nothing new.
- `app.attach({ operationId })` **replays the recorded history** of an operation
  from its start. Use it to read the original note after a repeat.

### Delivery diagnostics

`onDeliveryDiagnostic` is disabled by default. When you pass a function, the
runtime calls it at each step of a delivery's progress. Each diagnostic has a
`phase` and, where they apply, the IDs of the Event, delivery and consumer it
concerns. The phases you will see in a single-process application separate four
kinds of waiting and working:

| Phases                                      | What they tell you                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------ |
| `placement_requested`, `placement_accepted` | The delivery was handed to a worker. `placement_failed` means it could not be. |
| `capacity_blocked`, `capacity_unblocked`    | The delivery is queued, waiting for a free worker slot.                        |
| `worker_claimed`, `worker_handler_started`  | A worker took the delivery and started its Processor's handler.                |
| `worker_handler_settled`                    | The handler finished. `status` says how it ended; `error` says why it failed.  |

On `worker_handler_settled`, `status` is `succeeded` when the handler returned.
When the handler threw, `status` is usually `retry_wait` (the delivery will be
tried again) or `dead_letter` (it will not), and `error` holds the error's
`name` and a message truncated to 500 characters, plus an ellipsis when
truncated.

Diagnostics are observations, not records:

- They exist only in the process that produced them. Nothing is stored, and
  another process or a later run cannot read them.
- They never include the Event, its payload, or an error's stack or cause.
- The runtime ignores anything your function throws and any promise it returns
  rejecting, so a broken function cannot fail a delivery. It is still called on
  the same event loop as your handlers, so slow synchronous work in it adds
  latency. Keep it fast: record or enqueue each diagnostic and forward it
  elsewhere, and never base application decisions on diagnostics.
- Common credential shapes in error messages, such as bearer tokens or
  `password=…`, are masked on a best-effort basis. That is not a guarantee: a
  secret written into a custom error message can still appear. Do not put
  sensitive input into error messages, and do not treat the diagnostic function
  as a redaction boundary when you forward diagnostics to a log service.

### Create `notes.scenarios.ts`

`notes.scenarios.ts` is a **definition module** for tests. It declares the
scenarios as plain async functions and performs no I/O when imported: each
application is created inside a scenario, and closed in a `finally` block even
when an assertion fails. It uses `node:assert/strict`, which both Deno and Node
provide, so the two test runners share every check.

Its local imports are `notes-plugin.ts` only. It needs no package beyond
`@copilotz/copilotz`, no credential, no network, no subprocess and no file on
disk.

```ts
// Strict assertions from the Node standard library. Deno provides the same
// module, so the Deno and Node test runners share every check below.
import assert from "node:assert/strict";
// Runtime factory, the Processor helper for one test-only Processor, and the
// guard that separates byte streams from Events.
import {
  createCopilotz,
  defineProcessor,
  isStreamOutput,
} from "@copilotz/copilotz";
// Types of observed outputs and Events, of delivery diagnostics, and of the
// context the test-only Processor receives.
import type {
  ActionCallers,
  ApplicationOutput,
  ApplicationSendInput,
  DeliveryDiagnostic,
  DeliveryDiagnosticSink,
  ProcessorContext,
  ProcessorMap,
  ResolvedCopilotzEvent,
} from "@copilotz/copilotz";
// The reusable package under test, and the Action the test-only Processor
// calls. The tests import definitions only, never an entrypoint.
import { notesPlugin, saveNote } from "./notes-plugin.ts";
import type { SaveNoteInput } from "./notes-plugin.ts";

// Everything a scenario learns from one operation: the Events it saw, and
// whether the operation completed or failed.
type Observation = Readonly<{
  events: readonly ResolvedCopilotzEvent[];
  settled: PromiseSettledResult<void>;
}>;

// Reads an operation to the end. A send handle and an attachment both have
// `outputs` and `done`. Reading both together turns a failed operation into a
// result the scenario can check, instead of an unhandled rejection.
async function observe(
  operation: Readonly<{
    outputs: ReadableStream<ApplicationOutput>;
    done: Promise<void>;
  }>,
): Promise<Observation> {
  const events: ResolvedCopilotzEvent[] = [];
  const reading = (async () => {
    for await (const output of operation.outputs) {
      // Notes opens no byte streams. Release any that appear so they do not
      // hold the operation open.
      if (isStreamOutput(output)) {
        await output.payload.cancel();
        continue;
      }
      events.push(output);
    }
  })();
  const [read, settled] = await Promise.allSettled([reading, operation.done]);
  // A broken output stream is a failure of its own, whatever `done` did.
  if (read.status === "rejected") throw read.reason;
  return { events, settled };
}

// Rethrows the operation's own error, so a failed run reports why it failed.
function assertCompleted(observation: Observation): void {
  if (observation.settled.status === "rejected") {
    throw observation.settled.reason;
  }
}

// Recorded (durable) Events of one type. Live Events are never stored.
function recorded(
  observation: Observation,
  type: string,
): ResolvedCopilotzEvent[] {
  return observation.events.filter((event) =>
    event.durable && event.type === type
  );
}

// The two note fields the scenarios compare. Event data is `unknown` at run
// time, so every note is checked before it is used.
type SavedNote = Readonly<{ id: string; text: string }>;

function field(data: unknown, key: string): unknown {
  return typeof data === "object" && data !== null
    ? (data as Record<string, unknown>)[key]
    : undefined;
}

function savedNote(value: unknown): SavedNote {
  if (
    typeof value === "object" && value !== null &&
    "id" in value && typeof value.id === "string" &&
    "text" in value && typeof value.text === "string"
  ) {
    return { id: value.id, text: value.text };
  }
  throw new Error(`Expected a stored note, got ${JSON.stringify(value)}.`);
}

// The notes an operation recorded: the stored `record` on each `note.created`
// Event, or the returned `output` on each `notes.save.completed` Event.
function notesIn(
  observation: Observation,
  type: "note.created" | "notes.save.completed",
): SavedNote[] {
  const key = type === "note.created" ? "record" : "output";
  return recorded(observation, type).map((event) =>
    savedNote(field(event.data, key))
  );
}

// Collects one application's delivery diagnostics, and lets a scenario wait
// for the diagnostic that reports how a delivery ended.
function createDiagnosticLog() {
  const seen: DeliveryDiagnostic[] = [];
  const waiting = new Map<string, (diagnostic: DeliveryDiagnostic) => void>();
  const isSettled = (diagnostic: DeliveryDiagnostic, eventId: string) =>
    diagnostic.phase === "worker_handler_settled" &&
    diagnostic.eventId === eventId;

  // Passed to `createCopilotz` as `onDeliveryDiagnostic`. It only records and
  // returns at once, so it adds no noticeable work to deliveries.
  const sink: DeliveryDiagnosticSink = (diagnostic) => {
    seen.push(diagnostic);
    if (diagnostic.eventId && isSettled(diagnostic, diagnostic.eventId)) {
      waiting.get(diagnostic.eventId)?.(diagnostic);
    }
  };

  return {
    sink,
    // In report order, so a delivery's steps can be read in sequence.
    forEvent(eventId: string): DeliveryDiagnostic[] {
      return seen.filter((diagnostic) => diagnostic.eventId === eventId);
    },
    // The diagnostic that reports how the Event's delivery ended. It can be
    // reported just after the operation settles, so wait for it, with a limit
    // that turns a missing report into a failure instead of a hang.
    settled(eventId: string): Promise<DeliveryDiagnostic> {
      const reported = seen.find((diagnostic) =>
        isSettled(diagnostic, eventId)
      );
      if (reported) return Promise.resolve(reported);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(eventId);
          reject(new Error(`No settled delivery reported for ${eventId}.`));
        }, 5_000);
        waiting.set(eventId, (diagnostic) => {
          clearTimeout(timer);
          waiting.delete(eventId);
          resolve(diagnostic);
        });
      });
    },
  };
}

// What a scenario may add around the Notes plugin.
type NotesTestOptions = Readonly<{
  // Receives delivery diagnostics. Diagnostics stay off when omitted.
  onDeliveryDiagnostic?: DeliveryDiagnosticSink;
  // Test-only Processors composed next to the plugin.
  processors?: ProcessorMap;
}>;

// A fresh application around the Notes plugin. `database` is omitted, so each
// call gets its own private in-memory database: scenarios never see each
// other's notes, and nothing is left on disk after `close()`.
function openNotes(options: NotesTestOptions = {}) {
  return createCopilotz({
    // A test namespace, so test Events are never mistaken for real ones.
    namespace: "team-notes-test",
    // Only the package under test. Plugins added to the application later do
    // not change this boundary.
    plugins: [notesPlugin],
    ...options,
  });
}

// The context the test-only Processor expects. Like `notes.capture`, it calls
// the `notes.save` Action through `context.actions.saveNote`.
type SavePairContext = ProcessorContext<
  ProcessorContext["resources"],
  ProcessorContext["adapters"],
  ActionCallers<{ saveNote: typeof saveNote }>
>;

// Test-only caller that saves two notes from one request, so a single delivery
// makes two separate `notes.save` calls.
const savePair = defineProcessor<SavePairContext>({
  // Its own stable ID and Event type, so it never reacts to capture requests.
  id: "notes-test.save-pair",
  on: [{ eventType: "notes-test.pair.requested" }],
  async handle(event, context) {
    // Save only for stored requests, like the `notes.capture` Processor.
    if (!event.durable) return;
    // TypeScript-only cast: `notes.save` validates each input before it runs.
    const { first, second } = event.data as {
      first: SaveNoteInput;
      second: SaveNoteInput;
    };
    // Two calls in one delivery, each named by its own operation key.
    await context.actions.saveNote(first, { operationKey: "save-first" });
    await context.actions.saveNote(second, { operationKey: "save-second" });
  },
});

// Each scenario is a plain async function. The test files register them by
// name, so both runners execute exactly the same checks.
export const notesScenarios: Readonly<Record<string, () => Promise<void>>> = {
  async "a capture request saves one note"() {
    const diagnostics = createDiagnosticLog();
    const app = await openNotes({ onDeliveryDiagnostic: diagnostics.sink });
    try {
      const handle = await app.send({
        type: "notes.capture.requested",
        payload: { text: "Prepare the release." },
      });
      const run = await observe(handle);
      assertCompleted(run);

      // One call to `notes.save`, which stored one note with the sent text.
      assert.equal(recorded(run, "notes.save.invoked").length, 1);
      const created = notesIn(run, "note.created");
      assert.equal(created.length, 1, "Expected exactly one stored note.");
      assert.equal(created[0].text, "Prepare the release.");

      // The Action completed once and returned the note it stored.
      const returned = notesIn(run, "notes.save.completed");
      assert.equal(returned.length, 1, "Expected one completed save.");
      assert.deepEqual(returned[0], created[0]);

      // The delivery ended successfully, and the operation is recorded as
      // completed.
      const settled = await diagnostics.settled(handle.eventId);
      assert.equal(settled.status, "succeeded");
      assert.equal(settled.error, undefined);
      const status = await app.operationStatus({
        operationId: handle.operationId,
      });
      assert.equal(status?.state, "completed");
    } finally {
      await app.close();
    }
  },

  async "repeating the same request reuses the saved note"() {
    const app = await openNotes();
    try {
      // One complete input, sent twice unchanged. The correlation ID is part of
      // the Event's identity, so a retry must reuse it with the deduplication
      // ID rather than let `app.send` generate a new one.
      const request: ApplicationSendInput = {
        type: "notes.capture.requested",
        payload: { text: "Prepare the release." },
        correlationId: "notes-test-capture",
        deduplicationId: "capture-1",
      };

      const first = await app.send(request);
      const firstRun = await observe(first);
      assertCompleted(firstRun);
      const [original] = notesIn(firstRun, "note.created");
      assert.ok(original, "The first request should store a note.");

      // The repeat is admitted as the original Event and operation.
      const repeat = await app.send(request);
      assert.equal(repeat.operationId, first.operationId);
      assert.equal(repeat.eventId, first.eventId);
      // Its outputs are live only. The operation already finished, so the
      // repeat sees no new note being stored.
      const repeatRun = await observe(repeat);
      assertCompleted(repeatRun);
      assert.equal(notesIn(repeatRun, "note.created").length, 0);

      // Replaying the recorded history still shows exactly the original note.
      const history = await observe(
        await app.attach({ operationId: first.operationId }),
      );
      assertCompleted(history);
      assert.deepEqual(notesIn(history, "note.created"), [original]);
    } finally {
      await app.close();
    }
  },

  async "an empty note fails without saving"() {
    const diagnostics = createDiagnosticLog();
    const app = await openNotes({ onDeliveryDiagnostic: diagnostics.sink });
    try {
      // `app.send` accepts the request: only `notes.save` checks the text.
      const handle = await app.send({
        type: "notes.capture.requested",
        payload: { text: "" },
      });
      const run = await observe(handle);

      // `notes.capture` uses the default `inherit` settlement, so the
      // operation fails when its delivery fails.
      assert.equal(
        run.settled.status,
        "rejected",
        "An empty note must fail its operation.",
      );
      // The request itself stays recorded; no save started and no note exists.
      assert.equal(recorded(run, "notes.capture.requested").length, 1);
      assert.equal(recorded(run, "notes.save.invoked").length, 0);
      assert.equal(notesIn(run, "note.created").length, 0);

      // Wait for the final report before reading the delivery's steps.
      // Invalid input is never retried: the delivery is dead-lettered, and the
      // error names the failed input check. The message text is not asserted.
      const settled = await diagnostics.settled(handle.eventId);
      assert.equal(settled.status, "dead_letter");
      assert.equal(settled.error?.name, "ActionInputValidationError");

      // The delivery was claimed, its handler started, and it settled once.
      const steps = diagnostics.forEvent(handle.eventId)
        .map((diagnostic) => diagnostic.phase)
        .filter((phase) => phase.startsWith("worker_"));
      assert.deepEqual(steps, [
        "worker_claimed",
        "worker_handler_started",
        "worker_handler_settled",
      ]);

      const status = await app.operationStatus({
        operationId: handle.operationId,
      });
      assert.equal(status?.state, "failed");
    } finally {
      await app.close();
    }
  },

  async "two saves in one delivery store two notes"() {
    const app = await openNotes({ processors: { savePair } });
    try {
      const handle = await app.send({
        type: "notes-test.pair.requested",
        payload: {
          first: { text: "Draft the notes." },
          second: { text: "Review the notes." },
        },
      });
      const run = await observe(handle);
      assertCompleted(run);

      // Each call made its own write: two notes, two IDs, both texts.
      const created = notesIn(run, "note.created");
      assert.equal(created.length, 2, "Expected one note per save.");
      assert.notEqual(created[0].id, created[1].id);
      assert.deepEqual(
        created.map((note) => note.text).sort(),
        ["Draft the notes.", "Review the notes."],
      );
      assert.equal(notesIn(run, "notes.save.completed").length, 2);
    } finally {
      await app.close();
    }
  },
};
```

### Create `notes.test.ts`

`notes.test.ts` is the **entrypoint** for Deno's test runner. It only registers
each shared scenario with `Deno.test`, so it contains no assertions of its own.

```ts
// The shared scenarios. Every check lives there.
import { notesScenarios } from "./notes.scenarios.ts";

// One Deno test per scenario, named after it.
for (const [name, scenario] of Object.entries(notesScenarios)) {
  Deno.test(`Notes: ${name}`, scenario);
}
```

### Create `notes.node-test.ts`

`notes.node-test.ts` is the **entrypoint** for Node's built-in test runner. It
registers the same scenarios with `node:test`. Its name ends in `-test.ts`, not
`.test.ts`, so `deno test` does not also pick it up when it searches the project
for test files.

```ts
// Node's built-in test runner.
import { test } from "node:test";
// The same shared scenarios that `notes.test.ts` registers with Deno.
import { notesScenarios } from "./notes.scenarios.ts";

// One Node test per scenario, named after it.
for (const [name, scenario] of Object.entries(notesScenarios)) {
  test(`Notes: ${name}`, scenario);
}
```

## Check it works

Run the scenarios with either runtime. Name the file explicitly: Node's runner
also treats `*.test.ts` files as tests when it searches on its own, and
`notes.test.ts` only runs on Deno.

```sh
# Deno: -A grants the permissions the runtime and its in-memory database use.
deno test -A notes.test.ts
# Node 24+: runs the same scenarios, stripping type annotations from the .ts files.
node --test notes.node-test.ts
```

Deno reports something like this. Durations vary, and the order of the lines can
too:

```text
running 4 tests from ./notes.test.ts
Notes: a capture request saves one note ... ok (…ms)
Notes: repeating the same request reuses the saved note ... ok (…ms)
Notes: an empty note fails without saving ... ok (…ms)
Notes: two saves in one delivery store two notes ... ok (…ms)

ok | 4 passed | 0 failed (…ms)
```

Node lists the same four names with `✔` and ends with `pass 4` and `fail 0`.

Check these facts rather than the exact output:

- Both runners report the same four scenario names, all passing.
- No `data` directory or other file appears in the project: every scenario ran
  in its own in-memory database.

### When a scenario fails

A failing scenario prints the assertion that did not hold, with the expected and
actual values. Read it as a broken promise to callers:

- `Expected exactly one stored note.` means a request stored no note, or more
  than one.
- `An empty note must fail its operation.` means invalid input was accepted.
- If the operation itself failed, `assertCompleted` rethrows the operation's own
  error, so you see why it failed rather than only that it did.

To see one fail, edit `notes-plugin.ts`: in the `saveNote` Action's
`inputSchema`, replace `minLength: 1` with `minLength: 0`, then run the Deno or
Node command again. "An empty note fails without saving" now fails with
`An empty note must fail its operation.`, because the empty note is saved.
Replace `minLength: 0` with `minLength: 1` again, and all four scenarios pass.

For a delivery that fails, the diagnostics answer three questions in order:

1. **Was it picked up?** No `worker_claimed` for the Event means the delivery is
   still queued or was never handed to a worker. Look for `capacity_blocked` or
   `placement_failed`.
2. **Did the handler start?** `worker_claimed` without `worker_handler_started`
   means the failure happened while the handler's context was being prepared,
   before your Processor ran.
3. **How did it end?** `worker_handler_settled` gives the `status` and, for a
   thrown error, its `name` and a short message. `retry_wait` means the runtime
   will try again; `dead_letter` means it will not.

## What this unlocks

The Notes contract is now checked automatically, on both runtimes, without a
database, a credential or a network. You can:

- change `notes-plugin.ts` and learn in seconds whether every caller still gets
  one validated note per request;
- test retries the way a client performs them, by sending one complete input
  twice and replaying the recorded history with `app.attach`;
- compose a test-only Processor next to a plugin to exercise its Actions from a
  new kind of caller;
- pass `onDeliveryDiagnostic` to any `createCopilotz` call, including a host
  entrypoint, to see whether a delivery was queued, claimed, run and settled.

Run these scenarios in your application's own CI as focused checks of the Notes
contract. They do not replace the library's tests; they protect what your
application relies on.

The [Testing and Inspection reference](../../testing-and-inspection.md) covers
the other ways to observe a running application, and
[Events, Deliveries, and Recovery](../../events-deliveries-recovery.md) explains
delivery states, retries and dead letters.

## Next steps

- Next: [Chapter 7: Persist and Recover](07-persist-and-recover.md) keeps notes
  across restarts by changing the database choice in `composition.ts`, and shows
  how interrupted deliveries resume.
- Optional:
  [Chapter 14: Test Agents Without a Provider](../part-3-add-agent-behavior/14-test-agents-without-a-provider.md)
  applies the same scenario pattern to an agent, using a scripted model instead
  of a provider.
- Reference: [Testing and Inspection](../../testing-and-inspection.md) covers
  test composition, operation inspection and delivery diagnostics.
- Reference:
  [Events, Deliveries, and Recovery](../../events-deliveries-recovery.md)
  explains deduplication, delivery states and recovery in detail.
