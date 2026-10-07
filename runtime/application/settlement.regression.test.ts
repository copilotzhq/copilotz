import { assert, assertEquals, assertExists } from "@std/assert";
import { createEventStore, provisionCopilotzSchema } from "../events/index.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
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
