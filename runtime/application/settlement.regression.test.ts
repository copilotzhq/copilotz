import { assertEquals, assertExists } from "@std/assert";
import { createEventStore, createSqlSession } from "../events/index.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createCopilotzApplication } from "./application.ts";

for (const caller of ["send", "status"] as const) {
  Deno.test(`${caller} rechecks outstanding work created while remote outputs drain`, async () => {
    const database = await createTestDatabase({ url: ":memory:" });
    const databaseSchema = `settlement_${caller}`;
    const namespace = "tenant-a";
    const application = await createCopilotzApplication({
      database,
      databaseSchema,
      namespace,
      plugins: [],
    });
    const store = createEventStore({
      session: createSqlSession(database),
      schema: databaseSchema,
    });
    let drained = 0;
    let childId: string | undefined;
    let progressStarted = 0;
    let markProgress: () => void = () => {};
    const progressed = new Promise<void>((resolve) => {
      markProgress = resolve;
    });
    const settlementChecks: number[] = [];
    const originalOutstanding = application.events.outstanding;
    Object.assign(application.events, {
      // Neither completion path needs the public succeeded count.
      settlement() {
        throw new Error("Completion must use the internal non-success check.");
      },
      async outstanding(scopeNamespace: string, scopeId: string) {
        settlementChecks.push(performance.now());
        return await originalOutstanding(scopeNamespace, scopeId);
      },
    });
    Object.assign(application.execution, {
      async settleOutputs(scope: { settlementScopeId: string }) {
        drained++;
        if (childId) return;
        // Simulate a relayed final output creating durable follow-on work
        // after the first zero-work check, before the confirming snapshot.
        const child = await store.append({
          type: "remote.child",
          namespace,
          payload: {},
          settlementScopeId: scope.settlementScopeId,
        }, ["remote-worker"]);
        childId = child.deliveries[0].id;
      },
      awaitScopeProgress() {
        progressStarted = performance.now();
        markProgress();
        // This application has no local work task to wake the completion loop.
        return Promise.resolve(false);
      },
    });
    try {
      if (caller === "send") {
        const send = await application.send({ type: "remote.root" });
        await progressed;
        assertExists(childId);
        let finished = false;
        void send.done.then(() => {
          finished = true;
        });
        assertEquals(finished, false, "the drain-created work keeps send open");
        assertExists(
          await store.claimDelivery({ id: childId, owner: "remote-worker" }),
        );
        await store.succeedDelivery(childId, "remote-worker");
        await send.done;
        assertEquals(finished, true);
        assertEquals(drained, 2, "the second zero-work pass drains again");
        assertEquals(
          settlementChecks.length,
          4,
          "each zero-work pass confirms settlement after draining",
        );
        assertEquals(
          settlementChecks[2] - progressStarted >= 200,
          true,
          "no-local-work polling retains the 250ms fallback",
        );
        assertEquals(
          (await application.operationStatus({ operationId: send.operationId }))
            ?.state,
          "completed",
        );
      } else {
        const root = await application.events.append({
          type: "remote.root",
          namespace,
          payload: {},
        });
        assertEquals(
          (await application.operationStatus({ operationId: root.event.id }))
            ?.state,
          "running",
        );
        assertExists(childId);
        assertEquals(drained, 1);
        assertEquals(
          settlementChecks.length,
          2,
          "status confirms settlement after draining",
        );
        assertExists(
          await store.claimDelivery({ id: childId, owner: "remote-worker" }),
        );
        await store.succeedDelivery(childId, "remote-worker");
        assertEquals(
          (await application.operationStatus({ operationId: root.event.id }))
            ?.state,
          "completed",
        );
        assertEquals(drained, 2);
        assertEquals(settlementChecks.length, 4);
      }
    } finally {
      await application.shutdown();
      await database.close();
    }
  });
}
