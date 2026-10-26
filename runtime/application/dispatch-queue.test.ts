import { assert, assertEquals } from "@std/assert";
import { createCopilotzGateway, createCopilotzWorker } from "./index.ts";
import { defineProcessor } from "../plugins/index.ts";
import { createTestDatabase } from "../testing/ominipg.ts";

Deno.test("Gateway starts a waiting delivery as soon as worker capacity frees", async () => {
  const database = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
  });
  const databaseSchema = "gateway_dispatch_queue";
  const transport = {
    type: "in-process",
    config: { topic: crypto.randomUUID() },
  } as const;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  let firstFinished = 0;
  let secondStarted = 0;
  let refused = 0;
  const processors = Object.fromEntries(["first", "second"].map((id) => [
    id,
    defineProcessor({
      id: `queue.${id}`,
      on: [{ eventType: "queue.test" }],
      async handle() {
        if (++calls === 1) {
          entered.resolve();
          await release.promise;
          firstFinished = performance.now();
        } else {
          secondStarted = performance.now();
        }
      },
    }),
  ]));
  const gateway = await createCopilotzGateway({
    database,
    databaseSchema,
    namespace: "queue-test",
    transports: [transport],
    target: { workerId: "queue-worker" },
    processors,
    onDeliveryDiagnostic(diagnostic) {
      if (diagnostic.phase === "placement_failed") refused++;
    },
  });
  const worker = await createCopilotzWorker({
    databaseSchema,
    namespace: "queue-test",
    transport,
    id: "queue-worker",
    capacity: 1,
    processors,
  });
  try {
    await worker.ready;
    // One event creates both obligations together; keep the first slot occupied
    // until the second dispatch is queued (or refused on the old default).
    const sent = gateway.send({ type: "queue.test", payload: {} });
    await entered.promise;
    const deadline = performance.now() + 5_000;
    while (
      gateway.hypervisor!.snapshot().queuedDispatches !== 1 && refused < 2
    ) {
      assert(performance.now() < deadline, "second delivery reached placement");
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    release.resolve();
    const run = await sent;
    await run.done;
    assertEquals(calls, 2);
    const gapMs = secondStarted - firstFinished;
    console.log(
      `worker capacity=1; finish-to-next-start=${gapMs.toFixed(1)} ms`,
    );
    assert(
      gapMs >= 0 && gapMs < 100,
      `waiting delivery took ${gapMs.toFixed(1)} ms`,
    );
    assertEquals(refused, 0);
  } finally {
    release.resolve();
    await Promise.allSettled([gateway.shutdown(), worker.stop()]);
    await database.query(`DROP SCHEMA IF EXISTS "${databaseSchema}" CASCADE`);
    await database.close();
  }
});
