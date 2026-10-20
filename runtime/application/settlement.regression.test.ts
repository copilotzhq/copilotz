import { assert, assertEquals, assertExists } from "@std/assert";
import { createEventStore, provisionCopilotzSchema } from "../events/index.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { definePlugin, defineProcessor } from "../plugins/index.ts";
import { createCopilotzApplication } from "./application.ts";
import {
  createOperationCatalog,
  provisionOperationCatalog,
} from "../streams/catalog.ts";

Deno.test("the settlement owner rechecks work created while final outputs drain", async () => {
  const database = await createTestDatabase({ url: ":memory:" });
  const schema = "settlement_drain";
  const namespace = "tenant-a";
  await provisionCopilotzSchema(database, schema);
  await provisionOperationCatalog(database, schema);
  let drained = 0;
  let childId: string | undefined;
  const catalog = createOperationCatalog(database, schema, {
    async beforeTerminal(scope) {
      drained++;
      if (childId) return;
      const child = await store.append({
        type: "remote.child",
        namespace,
        payload: {},
        settlementScopeId: scope.operationId,
      }, ["remote-worker"]);
      childId = child.deliveries[0].id;
    },
  });
  const store = createEventStore({
    session: database,
    schema,
    admitOperationEventSql: (input, param) =>
      catalog.admitEventSql(input, param),
    indexOperationEventSql: (input, param) =>
      catalog.indexEventSql(input, param),
  });
  try {
    const root = await store.append({
      type: "remote.root",
      namespace,
      payload: {},
    });
    assertEquals(await catalog.reconcile(), 0);
    assertExists(childId);
    assert(
      ["accepted", "running"].includes(
        (await catalog.get(namespace, root.event.id))!.state,
      ),
    );
    assertExists(
      await store.claimDelivery({ id: childId, owner: "remote-worker" }),
    );
    await store.succeedDelivery(childId, "remote-worker");
    assertEquals(await catalog.reconcile(), 1);
    assertEquals(drained, 2);
    assertEquals(
      (await catalog.get(namespace, root.event.id))?.state,
      "completed",
    );
  } finally {
    await database.close();
  }
});

Deno.test("operation status does not perform settlement or output draining", async () => {
  const database = await createTestDatabase({ url: ":memory:" });
  const application = await createCopilotzApplication({
    database,
    databaseSchema: "settlement_status",
    namespace: "tenant-a",
    plugins: [],
  });
  try {
    const root = await application.events.append({
      type: "remote.root",
      namespace: "tenant-a",
      payload: {},
    });
    Object.assign(application.execution, {
      settleOutputs() {
        throw new Error("A status read must not drain outputs");
      },
    });
    const before = await application.operations.get("tenant-a", root.event.id);
    assertEquals(
      (await application.operationStatus({ operationId: root.event.id }))
        ?.state,
      before?.state,
    );
    assertEquals(
      await application.operations.get("tenant-a", root.event.id),
      before,
      "reading status leaves the durable operation untouched",
    );
  } finally {
    await application.shutdown();
    await database.close();
  }
});

Deno.test("send retains a settlement notification arriving during its status read", async () => {
  const database = await createTestDatabase();
  const releaseHandler = Promise.withResolvers<void>();
  const committed = Promise.withResolvers<void>();
  const application = await createCopilotzApplication({
    database,
    databaseSchema: "settlement_watch",
    namespace: "tenant-a",
    plugins: [definePlugin({
      id: "settlement-watch",
      version: "1",
      processors: {
        hold: defineProcessor({
          id: "settlement-watch.hold",
          on: [{ eventType: "watch.request" }],
          handle: () => releaseHandler.promise,
        }),
      },
    })],
  });
  const originalWatch = application.operations.watch;
  const originalGet = application.operations.get;
  let closed = 0;
  let firstRead = true;
  const notified: boolean[] = [];
  const unsubscribe = await application.operations.onChange((id, detail) => {
    // Checkpoint/heartbeat hints have no operation identity to look up.
    if (!id || detail.namespace !== "tenant-a") return;
    void originalGet(detail.namespace, id).then((state) => {
      if (state?.state === "completed") committed.resolve();
    }).catch(committed.reject);
  });
  Object.assign(application.operations, {
    async watch(...args: Parameters<typeof originalWatch>) {
      const watch = await originalWatch(...args);
      return {
        ...watch,
        async wait(...args: Parameters<typeof watch.wait>) {
          const hint = await watch.wait(...args);
          notified.push(hint);
          return hint;
        },
        close() {
          closed++;
          watch.close();
        },
      };
    },
    async get(...args: Parameters<typeof originalGet>) {
      const state = await originalGet(...args);
      if (firstRead) {
        firstRead = false;
        assert(state?.state !== "completed");
        releaseHandler.resolve();
        // Return the captured running state only after durable completion was
        // published, forcing the read/wait race without a wall-clock threshold.
        await committed.promise;
      }
      return state;
    },
  });
  const deadline = setTimeout(
    () => committed.reject(new Error("Settlement did not commit")),
    5_000,
  );
  try {
    const handle = await application.send({
      type: "watch.request",
      payload: {},
    });
    await handle.done;
    assertEquals(
      notified,
      [true],
      "the commit wake must be buffered, not polled",
    );
    assertEquals(closed, 1);
  } finally {
    clearTimeout(deadline);
    releaseHandler.resolve();
    unsubscribe();
    await application.shutdown();
    await database.close();
  }
});
