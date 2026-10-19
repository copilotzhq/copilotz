import { assertEquals, assertRejects } from "@std/assert";
import { createCopilotzApplication } from "../application/index.ts";
import {
  definePlugin,
  defineProcessor,
  type ProcessorContext,
} from "../plugins/index.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import {
  createScheduledJob,
  schedulesPlugin,
} from "../../plugins/schedules/index.ts";
import { createTestDomainContext } from "../../plugins/core/shared/testing/context.ts";

Deno.test("owner shutdown still cancels live deliveries and drains them after alarm cancellation fails", async () => {
  const db = await createTestDatabase();
  const entered = Promise.withResolvers<void>();
  let aborted = false;
  let failCancel = false;
  const timers = new Set<unknown>();
  const app = await createCopilotzApplication({
    database: db,
    databaseSchema: "alarm_shutdown",
    namespace: "test",
    plugins: [
      schedulesPlugin,
      definePlugin({
        id: "fixture.held",
        version: "1",
        processors: {
          held: defineProcessor<ProcessorContext>({
            id: "held",
            on: [{ eventType: "test.hold" }],
            async handle(_event, context) {
              entered.resolve();
              await new Promise<void>((resolve) => {
                const done = () => {
                  aborted = true;
                  resolve();
                };
                if (context.signal.aborted) done();
                else {context.signal.addEventListener("abort", done, {
                    once: true,
                  });}
              });
            },
          }),
        },
      }),
    ],
    engine: {
      alarmScheduler: {
        schedule(callback) {
          timers.add(callback);
          return callback;
        },
        cancel(handle) {
          timers.delete(handle);
          if (failCancel) throw new Error("alarm cancel failed");
        },
      },
    },
  });
  try {
    await createScheduledJob({
      id: "future-job",
      name: "Future job",
      schedule: { type: "cron", expression: "* * * * *" },
      payload: {},
    }, createTestDomainContext(app, "test"));
    const sent = await app.send({
      type: "test.hold",
      namespace: "test",
      payload: {},
    });
    await entered.promise;
    // Let the final command's committed alarm read finish before failure injection.
    for (let attempt = 0; timers.size === 0 && attempt < 100; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assertEquals(timers.size, 1);
    failCancel = true;
    await assertRejects(() => app.shutdown(), Error, "alarm cancel failed");
    await sent.done.catch(() => undefined);
    assertEquals(
      aborted,
      true,
      "timer cleanup errors cannot skip worker cancellation",
    );
    assertEquals(timers.size, 0);
  } finally {
    await app.shutdown().catch(() => undefined);
    await db.close();
  }
});
