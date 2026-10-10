---
title: "Testing and Inspection"
description: "Test Copilotz plugins in isolated in-memory applications on Deno and Node, inspect operations through public status, attach, list and checkpoint APIs, and read opt-in delivery diagnostics."
section: Operate
order: 10
status: stable
---

# Testing and Inspection

## The pain

A plugin change passes a manual run, then a client retries a request and gets a
conflict, or an empty note fails with nothing but a rejected `done`. Nobody can
tell whether the delivery was never claimed, whether its handler threw, or
whether the runtime will try again. Tests that reach into runtime tables or
private helpers break on every upgrade, and agent tests that call a real
provider are slow, paid and non-deterministic.

## The problem

Applications need one public contract for three jobs:

- **Isolated tests** that compose only the definitions under test, with no
  shared database, credential, network or host entrypoint.
- **Durable inspection** that answers "what happened to this operation?" from
  recorded state, in any process.
- **Live delivery visibility** that explains where a delivery stopped without
  becoming a second source of truth.

## The solution

Tests and hosts use the same public application surface returned by
`createCopilotz`. There is no separate testing or evaluation API.

### Test composition

- Each scenario creates a fresh application with `createCopilotz` and **omits
  `database`**, so it gets a private in-memory database that disappears on
  `close()`.
- Scenarios import pure definitions only (`notes-plugin.ts`, `assistant.ts`,
  `notes-tools.ts`), never `app.ts`, `composition.ts`, `agent.ts` or a live MCP
  host module.
- Scenarios are plain async functions using `node:assert/strict`. Thin wrappers
  register them with `Deno.test` and with `node:test`, as in
  [Chapter 6](getting-started/part-2-verify-and-recover/06-test-and-inspect.md).
- Agent scenarios replace the agent's whole `capabilities` object with exactly
  the grants under test, and supply a complete named entry in
  `resources.llmConnections` (for example `openai: { adapter: "scripted" }`)
  backed by a scripted adapter built with `createLlmAdapter`, as in
  [Chapter 14](getting-started/part-3-add-agent-behavior/14-test-agents-without-a-provider.md).
  No provider is called.
- Model **quality** evaluation (is the reply good?) is application-owned and
  runs separately. Copilotz tests assert orchestration: which Events, Action
  calls and terminal states occurred.

### Inspecting operations

| API                                                  | Answers                                                                                          | Durable?            |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------- |
| `handle.outputs` from `app.send`                     | Events and byte streams produced **while you watch**                                             | Live view           |
| `handle.done`                                        | Resolves on success, rejects when the operation fails or is cancelled                            | Live view           |
| `app.operationStatus({ operationId })`               | `state` (`accepted`, `running`, `completed`, `failed`, `cancelled`), timestamps, metadata        | Yes                 |
| `app.attach({ operationId, cursor? })`               | Replays recorded history from the start (or a cursor), then follows live output                  | Yes (replay)        |
| `app.listOperations({ states, metadata, ... })`      | Operations filtered by state, IDs or trusted `operationMetadata`                                 | Yes                 |
| `app.operationCheckpoint({ operationIds, cursor? })` | An opaque `attach` cursor that keeps your Event baseline and skips already-terminal stream lanes | Yes                 |
| `app.observe()`                                      | Every live output of this application instance                                                   | Live, process-local |

Rules worth testing:

- An identical retry must resend the **complete unchanged input**, including
  `correlationId` and `deduplicationId`. It returns the original `operationId`
  and `eventId`; its `outputs` show only live activity, so use `app.attach` to
  read the original result.
- `operationCheckpoint` does not take a snapshot itself. The caller owns a
  consistent history snapshot and passes its Event baseline as `cursor`; the
  checkpoint carries that baseline forward and marks stream lanes that are
  already terminal as consumed. Without a baseline, `attach` still replays the
  recorded Events. The cursor is opaque and is not an authorization token.
- `send.done` rejects when the operation fails or is cancelled. `attach.done`
  resolves once replay reaches **any** terminal state, so check
  `operationStatus` for failure.
- For agents, `done` alone does not prove a successful reply: a recorded
  `llm.call.failed` can coexist with a completed operation.
- `app.observe()` and raw outputs are host-side views. They are not filtered for
  end users and may include private agent data; never forward them unfiltered.

### Delivery diagnostics

Pass `onDeliveryDiagnostic` to `createCopilotz` (off by default). Each
`DeliveryDiagnostic` has a `phase`, a `timestampMs` and, where relevant,
`eventId`, `deliveryId`, `consumerId`, `operationId`, `workerId`, `status`,
`origin` (`direct`, `scheduled`, `recovery`) and `error`.

| Phases                                                          | Meaning                                                     |
| --------------------------------------------------------------- | ----------------------------------------------------------- |
| `child_delivery_scheduled`                                      | A recorded Event scheduled a consumer delivery              |
| `placement_requested`, `placement_accepted`, `placement_failed` | Handing the delivery to a worker                            |
| `capacity_blocked`, `capacity_unblocked`                        | Waiting for a free worker slot                              |
| `worker_claimed`, `worker_claim_skipped`                        | A worker took the delivery, or found it no longer claimable |
| `worker_handler_started`, `worker_handler_settled`              | The handler ran; `status` and `error` say how it ended      |
| `gateway_event_frame_received`                                  | A gateway received an Event frame from a remote worker      |
| `recovery_selected`                                             | Recovery picked an interrupted delivery                     |

On `worker_handler_settled`, `status` is a string, not a closed enum. A success
reports `succeeded`; a thrown error typically reports `retry_wait` or
`dead_letter`, but other values can appear, for example when the delivery was
cancelled concurrently or is no longer found. A thrown error appears as
`error.name` plus a message truncated to 500 characters (with an ellipsis when
cut), never the payload, stack or cause.

Diagnostics are observations, not records:

- They are process-local and never stored. A diagnostic does **not** replace
  `operationStatus` or recorded Events.
- Sync throws and async rejections from the sink are swallowed, and async sinks
  are not awaited. Synchronous work still runs on the delivery path, so keep the
  sink fast: record or enqueue, then forward elsewhere.
- Credential-shaped text in messages is masked on a best-effort basis only. The
  sink is not a security redaction boundary.

### Example: a misbehaving sink cannot fail a delivery

This scenario reuses `notes-plugin.ts` from
[Chapter 5](getting-started/part-1-design-and-build/05-package-a-plugin.md). It
needs `@copilotz/copilotz` `^0.87.1`, installed as in the
[Quickstart](quickstart.md) (JSR on Deno; on Node, the JSR package plus its
PGlite dependency). It uses no credential, no network and no persistent
database.

Create `inspection.scenarios.ts`:

```ts
// Shared strict assertions, available on both Deno and Node.
import assert from "node:assert/strict";
// Public runtime factory and the guard that separates byte streams from Events.
import { createCopilotz, isStreamOutput } from "@copilotz/copilotz";
import type {
  ApplicationOutput,
  DeliveryDiagnostic,
  DeliveryDiagnosticSink,
} from "@copilotz/copilotz";
// The pure plugin under test; no host composition or entrypoint.
import { notesPlugin } from "./notes-plugin.ts";

// Drains outputs and done together, then reports a stream failure first and
// the operation's own failure second.
async function drain(
  operation: Readonly<{
    outputs: ReadableStream<ApplicationOutput>;
    done: Promise<void>;
  }>,
): Promise<string[]> {
  const types: string[] = [];
  const reading = (async () => {
    for await (const output of operation.outputs) {
      // Release byte streams Notes never opens, so they cannot hold the read.
      if (isStreamOutput(output)) {
        await output.payload.cancel();
        continue;
      }
      if (output.durable) types.push(output.type);
    }
  })();
  const [read, settled] = await Promise.allSettled([reading, operation.done]);
  if (read.status === "rejected") throw read.reason;
  if (settled.status === "rejected") throw settled.reason;
  return types;
}

export const inspectionScenarios: Readonly<
  Record<string, () => Promise<void>>
> = {
  async "a throwing diagnostic sink does not fail the delivery"() {
    const seen: DeliveryDiagnostic[] = [];
    let calls = 0;
    // Records each diagnostic, then alternately throws and rejects. The
    // runtime must ignore both.
    const sink: DeliveryDiagnosticSink = (diagnostic) => {
      seen.push(diagnostic);
      calls += 1;
      if (calls % 2 === 0) return Promise.reject(new Error("sink rejected"));
      throw new Error("sink threw");
    };
    // No database: a private in-memory store owned by this scenario only.
    const app = await createCopilotz({
      namespace: "team-notes-test",
      plugins: [notesPlugin],
      onDeliveryDiagnostic: sink,
    });
    try {
      const handle = await app.send({
        type: "notes.capture.requested",
        payload: { text: "Inspect the release." },
      });
      const live = await drain(handle);
      assert.ok(live.includes("note.created"));

      // Durable status, not the diagnostic, is the source of truth.
      const status = await app.operationStatus({
        operationId: handle.operationId,
      });
      assert.equal(status?.state, "completed");

      // Listing by state finds the operation from recorded state.
      const completed = await app.listOperations({ states: ["completed"] });
      assert.ok(completed.some((op) => op.operationId === handle.operationId));

      // Attaching replays the recorded history, including the stored note.
      const replay = await drain(
        await app.attach({ operationId: handle.operationId }),
      );
      assert.ok(replay.includes("note.created"));

      // The sink still saw the delivery settle successfully.
      assert.ok(
        seen.some((diagnostic) =>
          diagnostic.phase === "worker_handler_settled" &&
          diagnostic.eventId === handle.eventId &&
          diagnostic.status === "succeeded"
        ),
      );
    } finally {
      await app.close();
    }
  },
};
```

Register it like Chapter 6's scenarios. `inspection.test.ts` for Deno:

```ts
// Every check lives in the shared scenarios.
import { inspectionScenarios } from "./inspection.scenarios.ts";

for (const [name, scenario] of Object.entries(inspectionScenarios)) {
  Deno.test(`Inspection: ${name}`, scenario);
}
```

`inspection.node-test.ts` for Node 24+:

```ts
// Node's built-in test runner, registering the same scenarios.
import { test } from "node:test";
import { inspectionScenarios } from "./inspection.scenarios.ts";

for (const [name, scenario] of Object.entries(inspectionScenarios)) {
  test(`Inspection: ${name}`, scenario);
}
```

```sh
# Deno: -A grants the permissions the runtime and in-memory database use.
deno test -A inspection.test.ts
# Node 24+: runs the same scenario through node:test.
node --test inspection.node-test.ts
```

Each runner reports one passing test,
`Inspection: a throwing diagnostic sink does not fail the delivery`.

## What this unlocks

- Fast, isolated plugin and agent tests on both runtimes, without credentials,
  paid model calls or private helpers.
- Support tooling that answers "what happened?" from `operationStatus`,
  `listOperations` and `attach`, in any process sharing the database.
- Live diagnostics forwarded to your own logging, without risking delivery
  failures from a broken sink.

## Next steps

- Tutorial:
  [Chapter 6: Test and Inspect](getting-started/part-2-verify-and-recover/06-test-and-inspect.md)
  builds the full Notes scenario suite.
- Tutorial:
  [Chapter 14: Test Agents Without a Provider](getting-started/part-3-add-agent-behavior/14-test-agents-without-a-provider.md)
  scripts model responses.
- Reference: [Events, Deliveries, and Recovery](events-deliveries-recovery.md)
  explains delivery states, retries and dead letters.
- Reference: [Streams](streams.md) covers outputs, cursors and replay.
