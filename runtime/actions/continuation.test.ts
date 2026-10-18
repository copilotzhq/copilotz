import { assert, assertEquals, assertExists } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createCopilotzApplication } from "../application/application.ts";
import { createEventStore } from "../events/store.ts";
import {
  definePlugin,
  defineProcessor,
  type ProcessorContext,
} from "../plugins/index.ts";
import { defineAction } from "./define.ts";
import type { ActionContext, RuntimeActionCallers } from "./types.ts";
import type { ActionContinuation, OperationOutcome } from "./continuation.ts";
import { parseActionLifecycleEvent } from "./event.ts";

function gate() {
  let open!: () => void;
  return {
    wait: new Promise<void>((resolve) => {
      open = resolve;
    }),
    open: () => open(),
  };
}
async function eventually(check: () => Promise<boolean>) {
  const end = Date.now() + 10000;
  while (!await check()) {
    assert(Date.now() < end, "Timed out waiting for durable continuation");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
const call = (
  context: ProcessorContext | ActionContext,
  action: string,
  input: unknown,
) => (context.actions as RuntimeActionCallers)[action](input);

for (const parallel of [false, true]) {
  Deno.test(`operation continuations: ${parallel ? "parallel" : "nested"} children release capacity one and publish once`, async () => {
    const db = await createTestDatabase({ url: ":memory:" });
    const order: number[] = [];
    const work = defineAction<{ depth: number }, number | ActionContinuation>({
      id: "test.work",
      execute(input, context) {
        if (!input.depth) return 0;
        return context.awaitOperation({
          start: { action: "work", input: { depth: input.depth - 1 } },
          handoff: input,
        });
      },
      resume(handoff, outcome) {
        assertEquals(outcome.status, "completed");
        const depth = (handoff as { depth: number }).depth;
        order.push(depth);
        return depth;
      },
    });
    const app = await createCopilotzApplication({
      database: db,
      namespace: "test",
      databaseSchema: "continuation_tree",
      engine: { execution: { capacity: 1 } },
      plugins: [
        definePlugin({
          id: "test.tree",
          version: "1.0.0",
          actions: { work },
          processors: {
            start: defineProcessor({
              id: "test.start",
              on: [{ eventType: "test.start" }],
              async handle(_event, context: ProcessorContext) {
                await Promise.all(
                  Array.from(
                    { length: parallel ? 2 : 1 },
                    () => call(context, "work", { depth: 2 }),
                  ),
                );
              },
            }),
          },
        }),
      ],
    });
    try {
      const sent = await app.send({
        type: "test.start",
        metadata: { observationKeys: ["thread:test"] },
      });
      await sent.outputs.cancel();
      await sent.done;
      assertEquals(order.filter((n) => n === 1).length, parallel ? 2 : 1);
      assertEquals(order.filter((n) => n === 2).length, parallel ? 2 : 1);
      const operations = await app.operations.list({ namespace: "test" });
      assertEquals(operations.length, parallel ? 5 : 3);
      assert(operations.every((op) => op.state === "completed"));
      assert(
        operations.filter((op) => op.operationId !== sent.eventId).every((op) =>
          op.parent?.actionRunId
        ),
      );
      const feed = await app.operations.listSelectionChanges({
        namespace: "test",
        selectionKey: "thread:test",
      });
      assertEquals(feed.length, operations.length);
      const store = createEventStore({
        session: db,
        schema: "continuation_tree",
      });
      assertEquals(
        (await db.query(`SELECT * FROM ${store.tables.open_actions}`)).rows
          .length,
        0,
      );
      const resumes = await db.query(
        `SELECT deduplication_id FROM ${store.tables.events} WHERE type = 'copilotz.action.resume'`,
      );
      assertEquals(resumes.rows.length, parallel ? 4 : 2);
      assert(
        resumes.rows.every((row) =>
          String(row.deduplication_id).endsWith(":resume")
        ),
      );
    } finally {
      await app.close();
      await db.close();
    }
  });
}

for (const cancel of ["parent", "child"] as const) {
  Deno.test(`operation continuations: cancelling ${cancel} preserves cancellation direction`, async () => {
    const db = await createTestDatabase({ url: ":memory:" });
    const entered = gate();
    const release = gate();
    let runId = "";
    let outcome: OperationOutcome | undefined;
    const work = defineAction({
      id: "test.wait",
      execute(_input: unknown, context: ActionContext) {
        runId = context.action.runId;
        return context.awaitOperation({
          start: { action: "child", input: {} },
          handoff: { captured: true },
        });
      },
      resume(handoff, result) {
        assertEquals(handoff, { captured: true });
        outcome = result;
        return "handled";
      },
    });
    const child = defineAction({
      id: "test.child",
      async execute(_input: unknown, context: ActionContext) {
        entered.open();
        await release.wait;
        context.signal.throwIfAborted();
        return "child";
      },
    });
    const app = await createCopilotzApplication({
      database: db,
      namespace: "test",
      databaseSchema: "continuation_cancel",
      plugins: [
        definePlugin({
          id: "test.cancel",
          version: "1.0.0",
          actions: { work, child },
          processors: {
            start: defineProcessor({
              id: "test.start",
              on: [{ eventType: "test.start" }],
              async handle(_event, context: ProcessorContext) {
                await call(context, "work", {});
              },
            }),
          },
        }),
      ],
    });
    try {
      const sent = await app.send({ type: "test.start" });
      const done = sent.done.then(() => "completed", () => "cancelled");
      await sent.outputs.cancel();
      await entered.wait;
      const childId = `${runId}:child`;
      await app.cancelOperation({
        operationId: cancel === "parent" ? sent.eventId : childId,
      });
      release.open();
      if (cancel === "parent") {
        assertEquals(await done, "cancelled");
        assertEquals(outcome, undefined);
        await app.maintenance();
        assertEquals(
          (await app.operations.get("test", childId))?.state,
          "cancelled",
        );
      } else {
        assertEquals(await done, "completed");
        assertEquals(outcome, { operationId: childId, status: "cancelled" });
      }
    } finally {
      release.open();
      await app.close();
      await db.close();
    }
  });
}

Deno.test("operation continuation waits for the child's last stream terminal without a maintenance sweep", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const opened = gate();
  let runId = "";
  let childId = "";
  const work = defineAction({
    id: "test.stream-wait",
    execute(_input: unknown, context: ActionContext) {
      runId = context.action.runId;
      return context.awaitOperation({
        start: { action: "child", input: {} },
        handoff: {},
      });
    },
    resume() {
      return "ready";
    },
  });
  const child = defineAction({
    id: "test.stream-child",
    async execute(_input: unknown, context: ActionContext) {
      childId = context.identity.settlementScopeId!;
      await app.operations.openStream({
        namespace: "test",
        operationId: childId,
        semanticStreamId: "last",
        bodyId: "body",
        descriptor: {
          type: "stream.output",
          namespace: "test",
          streamId: "last",
          mediaType: "text/plain",
          kind: "text",
          role: "body",
          metadata: {},
        },
      });
      opened.open();
      return true;
    },
  });
  const app = await createCopilotzApplication({
    database: db,
    namespace: "test",
    databaseSchema: "continuation_stream",
    plugins: [
      definePlugin({
        id: "test.stream",
        version: "1.0.0",
        actions: { work, child },
        processors: {
          start: defineProcessor({
            id: "test.start",
            on: [{ eventType: "test.start" }],
            async handle(_event, context: ProcessorContext) {
              await call(context, "work", {});
            },
          }),
        },
      }),
    ],
  });
  try {
    const sent = await app.send({ type: "test.start" });
    await sent.outputs.cancel();
    await opened.wait;
    const store = createEventStore({
      session: db,
      schema: "continuation_stream",
    });
    await eventually(async () =>
      (await store.scopeSettlement("test", childId)).unsettled === 0
    );
    assertEquals(
      await store.getEventByDeduplicationId("test", `${runId}:action:terminal`),
      null,
    );
    await app.operations.sealStream({
      namespace: "test",
      operationId: childId,
      streamId: "last",
      body: {
        bodyId: "body",
        mediaType: "text/plain",
        byteLength: 0,
        digest: "sha256:empty",
        maintenanceVersion: 1,
        state: "ready",
      },
    });
    await sent.done;
    assertExists(
      await store.getEventByDeduplicationId("test", `${runId}:action:terminal`),
    );
  } finally {
    await app.close();
    await db.close();
  }
});

Deno.test("an exhausted resumption emits one failure terminal and fences late completion", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const entered = gate();
  const release = gate();
  let runId = "";
  let terminals = 0;
  const work = defineAction({
    id: "test.resume-failure",
    execute(_input: unknown, context: ActionContext) {
      runId = context.action.runId;
      return context.awaitOperation({
        start: { action: "child", input: {} },
        handoff: {},
      });
    },
    async resume() {
      entered.open();
      await release.wait;
      return "late";
    },
  });
  const app = await createCopilotzApplication({
    database: db,
    namespace: "test",
    databaseSchema: "continuation_failure",
    engine: { maxAttempts: 1, execution: { capacity: 2, heartbeatMs: 60000 } },
    plugins: [
      definePlugin({
        id: "test.failure",
        version: "1.0.0",
        actions: {
          work,
          child: defineAction({ id: "test.child", execute: () => true }),
        },
        processors: {
          start: defineProcessor({
            id: "test.start",
            on: [{ eventType: "test.start" }],
            async handle(_event, context: ProcessorContext) {
              await call(context, "work", {});
            },
          }),
          terminal: defineProcessor({
            id: "test.terminal",
            on: [{ eventType: "test.resume-failure.failed" }],
            handle(event) {
              const data = parseActionLifecycleEvent(event);
              assert(data?.status === "failed");
              assertEquals(data.actionRunId, runId);
              terminals++;
            },
          }),
        },
      }),
    ],
  });
  try {
    const sent = await app.send({ type: "test.start" });
    const done = sent.done.catch(() => undefined);
    await sent.outputs.cancel();
    await entered.wait;
    const store = createEventStore({
      session: db,
      schema: "continuation_failure",
    });
    const [delivery] = await store.listDeliveries({
      namespace: "test",
      settlementScopeId: sent.eventId,
      consumerId: "runtime:action-continuation",
    });
    assertExists(delivery);
    await db.query(
      `UPDATE ${store.tables.event_deliveries} SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1`,
      [delivery.id],
    );
    await app.maintenance();
    await eventually(() => Promise.resolve(terminals === 1));
    await done;
    release.open();
    await app.shutdown();
    assertEquals(terminals, 1);
    assertEquals(
      (await store.getEventByDeduplicationId(
        "test",
        `${runId}:action:terminal`,
      ))?.type,
      "test.resume-failure.failed",
    );
  } finally {
    release.open();
    await app.close();
    await db.close();
  }
});

Deno.test("a detached Action's public child carries observation keys without holding the foreground open", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const opened = gate();
  const release = gate();
  let runId = "";
  const work = defineAction({
    id: "test.background-wait",
    execute(_input: unknown, context: ActionContext) {
      runId = context.action.runId;
      return context.awaitOperation({
        start: { action: "child", input: {} },
        handoff: {},
      });
    },
    resume() {
      return "ready";
    },
  });
  const child = defineAction({
    id: "test.background-child",
    async execute() {
      opened.open();
      await release.wait;
      return true;
    },
  });
  const app = await createCopilotzApplication({
    database: db,
    namespace: "test",
    databaseSchema: "continuation_detached",
    plugins: [
      definePlugin({
        id: "test.detached",
        version: "1.0.0",
        actions: { work, child },
        processors: {
          start: defineProcessor({
            id: "test.start",
            on: [{ eventType: "test.start" }],
            settlement: "detached",
            async handle(_event, context: ProcessorContext) {
              await call(context, "work", {});
            },
          }),
        },
      }),
    ],
  });
  try {
    const sent = await app.send({
      type: "test.start",
      metadata: { observationKeys: ["thread:background"] },
    });
    await sent.outputs.cancel();
    await opened.wait;
    await sent.done;
    const childId = `${runId}:child`;
    const operations = await app.operations.list({ namespace: "test" });
    assertEquals(operations.length, 2);
    assertEquals(
      (await app.operations.get("test", sent.eventId))?.state,
      "completed",
    );
    assert(
      operations.some((op) =>
        op.operationId === childId && op.state !== "completed"
      ),
    );
    assertEquals(
      (await app.operations.listSelectionChanges({
        namespace: "test",
        selectionKey: "thread:background",
      })).length,
      2,
    );
    release.open();
    const store = createEventStore({
      session: db,
      schema: "continuation_detached",
    });
    await eventually(async () =>
      !!await store.getEventByDeduplicationId(
        "test",
        `${runId}:action:terminal`,
      )
    );
  } finally {
    release.open();
    await app.close();
    await db.close();
  }
});
