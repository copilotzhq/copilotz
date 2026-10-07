import { assert, assertEquals, assertExists } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createCopilotzApplication } from "../application/application.ts";
import { createCoreTableNames } from "../events/schema.ts";
import { createEventStore } from "../events/store.ts";
import {
  definePlugin,
  defineProcessor,
  type ProcessorContext,
} from "../plugins/index.ts";
import { defineAction } from "./define.ts";
import { type ActionDeferral, deferAction } from "./deferral.ts";
import type { ActionContext, RuntimeActionCallers } from "./types.ts";
import { parseActionLifecycleEvent } from "./event.ts";
import { markNonRetryable } from "../failure.ts";

function gate() {
  let open!: () => void;
  return {
    wait: new Promise<void>((resolve) => {
      open = resolve;
    }),
    open: () => open(),
  };
}

for (const fail of [false, true]) {
  Deno.test(`generic deferred work ${fail ? "failure" : "nested success"} uses ordinary Action terminals`, async () => {
    const db = await createTestDatabase({ url: ":memory:" });
    const schema = "generic_deferral";
    const tables = createCoreTableNames(schema);
    const started = gate();
    const proceed = gate();
    const order: string[] = [];
    let rootRun = "";
    const call = (
      context: ProcessorContext | ActionContext,
      name: string,
      input: unknown,
    ) => (context.actions as RuntimeActionCallers)[name](input);
    const work = defineAction<
      { depth: number },
      number | ActionDeferral,
      ActionContext,
      undefined,
      { readonly type: "number" }
    >({
      id: "test.work",
      outputSchema: { type: "number" },
      execute(input, context) {
        if (input.depth === 2) rootRun = context.action.runId;
        return deferAction(input);
      },
      resolve(input, _context, resolution) {
        order.push(`resolve:${input.depth}:${resolution.outcome}`);
        if (resolution.outcome !== "completed") throw new Error("work failed");
        return input.depth;
      },
    });
    const after = defineAction({
      id: "test.after",
      execute: () => {
        order.push("after");
        return true;
      },
    });
    const app = await createCopilotzApplication({
      database: db,
      namespace: "tenant",
      databaseSchema: schema,
      engine: { execution: { capacity: 1 } },
      plugins: [definePlugin({
        id: "test.generic-deferral",
        version: "1.0.0",
        actions: { work, after },
        processors: {
          start: defineProcessor({
            id: "test.start",
            on: [{ eventType: "test.start" }],
            async handle(_event, context: ProcessorContext) {
              await call(context, "work", { depth: 2 });
            },
          }),
          dispatch: defineProcessor({
            id: "test.dispatch",
            on: [{ eventType: "test.work.deferred" }],
            async handle(event, context: ProcessorContext) {
              const receipt = parseActionLifecycleEvent(event, {
                statuses: ["deferred"],
              });
              assert(receipt?.status === "deferred");
              const depth = (receipt.work as { depth: number }).depth;
              if (depth === 2) {
                started.open();
                await proceed.wait;
                if (fail) {
                  throw markNonRetryable(new Error("permanent work failure"));
                }
              }
              if (depth > 0) await call(context, "work", { depth: depth - 1 });
              order.push(`dispatch:${depth}`);
            },
          }),
          terminal: defineProcessor({
            id: "test.terminal",
            on: ["completed", "failed"].map((status) => ({
              eventType: `test.work.${status}`,
            })),
            async handle(event, context: ProcessorContext) {
              const receipt = parseActionLifecycleEvent(event, {
                statuses: ["completed", "failed"],
              });
              assertExists(receipt);
              order.push(
                `terminal:${
                  (receipt.input as { depth: number }).depth
                }:${receipt.status}`,
              );
              if (receipt.actionRunId === rootRun) {
                await call(context, "after", {});
              }
            },
          }),
        },
      })],
    });
    try {
      const sent = await app.send({ type: "test.start" });
      const done = sent.done.then(() => "completed", () => "failed");
      const outputs = (async () => {
        try {
          for await (const _ of sent.outputs) { /* drain */ }
        } catch { /* root failure expected */ }
      })();
      await started.wait;
      const store = createEventStore({ session: db, schema });
      const deliveries = await store.listDeliveries({
        namespace: "tenant",
        settlementScopeId: sent.eventId,
      });
      assertEquals(
        deliveries.find((d) => d.consumerId === "processor:test.start")?.status,
        "succeeded",
        "handoff releases the original worker",
      );
      assertEquals(
        (await db.query<{ state: string }>(
          `SELECT state FROM ${tables.open_actions} WHERE action_run_id = $1`,
          [rootRun],
        )).rows[0]?.state,
        "deferred",
      );
      assertEquals(
        await store.getEventByDeduplicationId(
          "tenant",
          `${rootRun}:action:terminal`,
        ),
        null,
      );
      proceed.open();
      assertEquals(await done, fail ? "failed" : "completed");
      await outputs;
      assertEquals(
        (await db.query(`SELECT * FROM ${tables.open_actions}`)).rows.length,
        0,
      );
      assertEquals(
        order.at(-1),
        "after",
        "parent continuation ran before operation settlement",
      );
      if (fail) {
        assertEquals(order, ["resolve:2:failed", "terminal:2:failed", "after"]);
      } else {
        assert(
          order.indexOf("terminal:0:completed") <
            order.indexOf("resolve:1:completed"),
        );
        assert(
          order.indexOf("terminal:1:completed") <
            order.indexOf("resolve:2:completed"),
        );
      }
    } finally {
      proceed.open();
      await app.shutdown();
      await db.close();
    }
  });
}

Deno.test("explicit scope cancellation closes deferred Actions and fences new work", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const schema = "deferred_cancel";
  const started = gate();
  const proceed = gate();
  let calls = 0;
  let run = "";
  const work = defineAction<unknown, string | ActionDeferral>({
    id: "test.cancel-work",
    execute(_input, context) {
      run = context.action.runId;
      return deferAction({ value: 1 });
    },
    resolve() {
      calls++;
      return "resolved";
    },
  });
  const sideEffect = defineAction({
    id: "test.side-effect",
    execute() {
      calls++;
    },
  });
  const app = await createCopilotzApplication({
    database: db,
    namespace: "tenant",
    databaseSchema: schema,
    plugins: [definePlugin({
      id: "test.cancel",
      version: "1.0.0",
      actions: { work, sideEffect },
      processors: {
        start: defineProcessor({
          id: "test.cancel.start",
          on: [{ eventType: "test.start" }],
          async handle(_event, context: ProcessorContext) {
            await (context.actions as RuntimeActionCallers).work({});
          },
        }),
        dispatch: defineProcessor({
          id: "test.cancel.dispatch",
          on: [{ eventType: "test.cancel-work.deferred" }],
          async handle(_event, context: ProcessorContext) {
            started.open();
            await proceed.wait;
            await (context.actions as RuntimeActionCallers).sideEffect({});
          },
        }),
        terminal: defineProcessor({
          id: "test.cancel.terminal",
          on: [{ eventType: "test.cancel-work.cancelled" }],
          handle() {
            calls++;
          },
        }),
      },
    })],
  });
  try {
    const sent = await app.send({ type: "test.start" });
    const done = sent.done.then(() => "completed", () => "cancelled");
    await sent.outputs.cancel();
    await started.wait;
    const status = await app.cancelOperation({
      operationId: sent.eventId,
      reason: "user cancellation",
    });
    assertEquals(status?.state, "cancelled");
    assertEquals(await done, "cancelled");
    const store = createEventStore({ session: db, schema });
    assertExists(
      await store.getEventByDeduplicationId("tenant", `${run}:action:terminal`),
    );
    assertEquals(
      (await db.query(`SELECT * FROM ${store.tables.open_actions}`)).rows
        .length,
      0,
    );
    const deliveries = await store.listDeliveries({
      namespace: "tenant",
      settlementScopeId: sent.eventId,
    });
    assert(
      deliveries.some((d) =>
        d.consumerId === "processor:test.cancel.terminal" &&
        d.status === "cancelled"
      ),
    );
    proceed.open();
    await app.shutdown();
    assertEquals(
      calls,
      0,
      "cancellation does not execute resolver or new side effects",
    );
  } finally {
    proceed.open();
    await app.shutdown();
    await db.close();
  }
});

Deno.test("detached deferred work and streams use the same lifecycle without holding the foreground open", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const opened = gate();
  const proceed = gate();
  const resolved = gate();
  const work = defineAction<unknown, string | ActionDeferral>({
    id: "test.background-work",
    execute() {
      return deferAction({});
    },
    resolve(_input, _context, resolution) {
      assertEquals(resolution.outcome, "completed");
      resolved.open();
      return "ready";
    },
  });
  const app = await createCopilotzApplication({
    database: db,
    namespace: "tenant",
    databaseSchema: "background_deferral",
    plugins: [
      definePlugin({
        id: "test.background",
        version: "1.0.0",
        actions: { work },
        processors: {
          start: defineProcessor({
            id: "test.background.start",
            on: [{ eventType: "test.background" }],
            settlement: "detached",
            async handle(_event, context: ProcessorContext) {
              await (context.actions as RuntimeActionCallers).work({});
            },
          }),
          dispatch: defineProcessor({
            id: "test.background.dispatch",
            on: [{ eventType: "test.background-work.deferred" }],
            async handle(_event, context: ProcessorContext) {
              const writer = await context.streams.open({
                id: "background-stream",
                mediaType: "text/plain",
                role: "output",
              });
              await writer.append({
                bytes: new TextEncoder().encode("background"),
                appendId: "one",
              });
              opened.open();
              await proceed.wait;
              await writer.close({ assetId: "background-result" });
            },
          }),
        },
      }),
    ],
  });
  try {
    const send = await app.send({
      type: "test.background",
      metadata: { observationKeys: ["thread:test"] },
    });
    await send.outputs.cancel();
    await opened.wait;
    await send.done;
    const [delivery] = await app.deliveries.list({
      namespace: "tenant",
      consumerId: "processor:test.background.start",
    });
    assertExists(delivery);
    const internal = delivery.settlementScopeId;
    assertEquals(
      (await app.operations.get("tenant", send.eventId))?.state,
      "completed",
    );
    assert(
      ["accepted", "running"].includes(
        (await app.operations.get("tenant", internal))!.state,
      ),
    );
    assertEquals(
      (await app.operations.list({ namespace: "tenant" })).map((op) =>
        op.operationId
      ),
      [send.eventId],
    );
    assertEquals(
      (await app.operations.listStreams({
        namespace: "tenant",
        operationId: internal,
      })).length,
      1,
    );
    assertEquals(
      (await app.operations.listStreams({
        namespace: "tenant",
        operationId: send.eventId,
      })).length,
      0,
    );
    proceed.open();
    await resolved.wait;
    const deadline = Date.now() + 5_000;
    while (
      (await app.operations.get("tenant", internal))?.state !== "completed" &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assertEquals(
      (await app.operations.get("tenant", internal))?.state,
      "completed",
    );
    assertEquals(
      (await app.operations.listSelectionChanges({
        namespace: "tenant",
        selectionKey: "thread:test",
      })).map((op) => op.operationId),
      [send.eventId],
    );
  } finally {
    proceed.open();
    await app.shutdown();
    await db.close();
  }
});

Deno.test("an exhausted resolver fails the same Action and runs its terminal continuation", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const started = gate();
  const proceed = gate();
  const continued = gate();
  let run = "";
  let terminals = 0;
  const work = defineAction<unknown, string | ActionDeferral>({
    id: "test.resolver-crash",
    execute(_input, context) {
      run = context.action.runId;
      return deferAction({ task: "synthetic" });
    },
    async resolve() {
      started.open();
      await proceed.wait;
      return "late result";
    },
  });
  const app = await createCopilotzApplication({
    database: db,
    namespace: "tenant",
    databaseSchema: "resolver_crash",
    engine: { maxAttempts: 1, execution: { capacity: 2, heartbeatMs: 60_000 } },
    plugins: [definePlugin({
      id: "test.resolver-crash",
      version: "1.0.0",
      actions: { work },
      processors: {
        start: defineProcessor({
          id: "test.resolver-crash.start",
          on: [{ eventType: "test.start" }],
          async handle(_event, context: ProcessorContext) {
            await (context.actions as RuntimeActionCallers).work({});
          },
        }),
        terminal: defineProcessor({
          id: "test.resolver-crash.terminal",
          on: [{ eventType: "test.resolver-crash.failed" }],
          handle(event) {
            const receipt = parseActionLifecycleEvent(event, {
              statuses: ["failed"],
            });
            assert(receipt?.status === "failed");
            assertEquals(receipt.actionRunId, run);
            assertEquals(receipt.error.name, "ActionDeliveryExhausted");
            terminals++;
            continued.open();
          },
        }),
      },
    })],
  });
  try {
    const sent = await app.send({ type: "test.start" });
    const done = sent.done.then(() => "completed", () => "failed");
    await sent.outputs.cancel();
    await started.wait;
    const store = createEventStore({ session: db, schema: "resolver_crash" });
    const [delivery] = await store.listDeliveries({
      namespace: "tenant",
      settlementScopeId: sent.eventId,
      consumerId: "runtime:action-resolver",
    });
    assertEquals(delivery?.status, "leased");
    await db.query(
      `UPDATE ${store.tables.event_deliveries} SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1`,
      [delivery.id],
    );
    await app.maintenance();
    await continued.wait;
    assertEquals(
      await done,
      "failed",
      "the stale resolver does not hold the operation open",
    );
    proceed.open();
    await app.shutdown();
    assertEquals(terminals, 1);
    assertEquals(
      (await db.query(`SELECT * FROM ${store.tables.open_actions}`)).rows,
      [],
    );
    const lifecycle = await store.getEventByDeduplicationId(
      "tenant",
      `${run}:action:terminal`,
    );
    assertEquals(
      lifecycle?.type,
      "test.resolver-crash.failed",
      "late resolver completion cannot overwrite recovery",
    );
  } finally {
    proceed.open();
    await app.shutdown();
    await db.close();
  }
});

Deno.test("the last stream terminal wakes deferred work without maintenance or status mutation", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const schema = "deferred_stream_wake";
  const opened = gate();
  let operationId = "";
  let actionRunId = "";
  const action = defineAction({
    id: "test.stream-wait",
    execute: () => deferAction({}),
    resolve: () => "done",
  });
  const app = await createCopilotzApplication({
    database: db,
    namespace: "tenant",
    databaseSchema: schema,
    plugins: [definePlugin({
      id: "test.stream-wake",
      version: "1.0.0",
      actions: { work: action },
      processors: {
        start: defineProcessor({
          id: "test.stream-start",
          on: [{ eventType: "test.start" }],
          async handle(_event, context: ProcessorContext) {
            await (context.actions as RuntimeActionCallers).work({});
          },
        }),
        work: defineProcessor({
          id: "test.stream-work",
          on: [{ eventType: "test.stream-wait.deferred" }],
          async handle(event) {
            const receipt = parseActionLifecycleEvent(event, {
              statuses: ["deferred"],
            });
            assert(receipt?.status === "deferred");
            actionRunId = receipt.actionRunId;
            // A cataloged stream is independently owned until its terminal arrives.
            await app.operations.openStream({
              namespace: "tenant",
              operationId,
              semanticStreamId: "last",
              bodyId: "body",
              descriptor: {
                type: "stream.output",
                namespace: "tenant",
                streamId: "last",
                mediaType: "text/plain",
                kind: "text",
                role: "body",
                metadata: { sourceActionScopeId: actionRunId },
              },
            });
            opened.open();
          },
        }),
      },
    })],
  });
  try {
    // Prevent dispatch before the operation identity is available to the fixture.
    const sent = await app.send({ type: "test.start" });
    operationId = sent.eventId;
    const drain = (async () => {
      for await (const _ of sent.outputs) { /* drain */ }
    })();
    await opened.wait;
    const store = createEventStore({ session: db, schema });
    const deadline = Date.now() + 5000;
    while ((await store.scopeSettlement("tenant", operationId)).unsettled) {
      assert(Date.now() < deadline);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assertEquals(
      (await db.query<{ state: string }>(
        `SELECT state FROM "${schema}".open_actions WHERE action_run_id = $1`,
        [actionRunId],
      )).rows[0]?.state,
      "deferred",
    );
    await app.operations.sealStream({
      namespace: "tenant",
      operationId,
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        sent.done,
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(new Error("Stream terminal did not wake Action resolver")),
            5000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    await drain;
    assertEquals(
      (await db.query(`SELECT * FROM "${schema}".open_actions`)).rows.length,
      0,
    );
  } finally {
    await app.close();
    await db.close();
  }
});

Deno.test("a failed writer releases deferred conversation work before prefix cleanup", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const schema = "deferred_failed_stream";
  const continued = gate();
  const operationReady = gate();
  let operationId = "";
  let resolvedOutcome = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const store = createEventStore({ session: db, schema });
  const work = defineAction({
    id: "test.failed-stream",
    execute: () => deferAction({}),
    resolve(_input, _context, resolution) {
      resolvedOutcome = resolution.outcome;
      throw new Error("Writer failed; parent may continue from the failure.");
    },
  });
  const app = await createCopilotzApplication({
    database: db,
    namespace: "tenant",
    databaseSchema: schema,
    plugins: [definePlugin({
      id: "test.failed-stream",
      version: "1.0.0",
      actions: { work },
      processors: {
        start: defineProcessor({
          id: "test.failed-stream.start",
          on: [{ eventType: "test.start" }],
          async handle(_event, context: ProcessorContext) {
            await (context.actions as RuntimeActionCallers).work({});
          },
        }),
        dispatch: defineProcessor({
          id: "test.failed-stream.dispatch",
          on: [{ eventType: "test.failed-stream.deferred" }],
          async handle(event) {
            assert(event.durable);
            await operationReady.wait;
            const receipt = parseActionLifecycleEvent(event, {
              statuses: ["deferred"],
            });
            assert(receipt?.status === "deferred");
            const [delivery] = await store.listDeliveries({
              namespace: "tenant",
              eventId: event.id,
              consumerId: "processor:test.failed-stream.dispatch",
            });
            assertExists(delivery);
            await app.operations.openStream({
              namespace: "tenant",
              operationId,
              semanticStreamId: "crashed-writer",
              bodyId: "missing-prefix",
              descriptor: {
                type: "stream.output",
                namespace: "tenant",
                streamId: "crashed-writer",
                mediaType: "text/plain",
                kind: "text",
                role: "body",
                metadata: {
                  sourceActionScopeId: receipt.actionRunId,
                  sourceDeliveryId: delivery.id,
                },
              },
            });
            throw markNonRetryable(new Error("Writer process crashed"));
          },
        }),
        terminal: defineProcessor({
          id: "test.failed-stream.terminal",
          on: [{ eventType: "test.failed-stream.failed" }],
          handle: () => continued.open(),
        }),
      },
    })],
  });
  try {
    const sent = await app.send({ type: "test.start" });
    operationId = sent.eventId;
    const done = sent.done.then(() => "completed", () => "failed");
    await sent.outputs.cancel();
    operationReady.open();
    await Promise.race([
      continued.wait,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Failed stream blocked continuation")),
          5000,
        );
      }),
    ]);
    clearTimeout(timer);
    assertEquals(resolvedOutcome, "failed");
    const stream = await app.operations.getStream(
      "tenant",
      operationId,
      "crashed-writer",
    );
    assertEquals(stream?.state, "terminating");
    assertEquals(stream?.outcome, "failed");
    assertEquals(
      (await app.operations.get("tenant", operationId))?.state,
      "running",
    );
    // Transport still has to finalize the retained prefix before root settlement.
    await app.maintenance();
    assertEquals(await done, "failed");
    assertEquals(
      (await app.operations.getStream("tenant", operationId, "crashed-writer"))
        ?.state,
      "terminal",
    );
  } finally {
    clearTimeout(timer);
    operationReady.open();
    await app.shutdown();
    await db.close();
  }
});
