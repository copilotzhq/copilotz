import { withApplicationIngress } from "../application/ingress/registry.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createCopilotzEngine } from "./engine.ts";
import { createPluginRegistry } from "../plugins/index.ts";
import { createContentCatalog } from "../content/catalog.ts";
import { createDatabaseBodyStore } from "../content/database-body-store.ts";
import { digestContent } from "../content/digest.ts";
import {
  createEventStore,
  provisionCopilotzSchema,
  type SqlSession,
} from "../events/index.ts";
import {
  createOperationCatalog,
  provisionOperationCatalog,
} from "../streams/catalog.ts";
import { createStreamOutputDescriptor } from "../streams/observation.ts";
import { createSchemaCommandRunner, openDatabaseOwner } from "./commands.ts";

Deno.test("engine admission waits for epoch invalidation and catalog recovery", async () => {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL")?.trim() || ":memory:",
  });
  const schema = `activation_recovery_${
    crypto.randomUUID().replaceAll("-", "")
  }`;
  await provisionCopilotzSchema(db, schema);
  await provisionOperationCatalog(db, schema);
  const owner = await openDatabaseOwner(db, schema);
  const store = createEventStore({ session: db, schema });
  const catalog = createOperationCatalog(db, schema);
  const event = await store.append(
    { type: "test", namespace: "space", payload: {} },
    ["crashed"],
    { maxAttempts: 1 },
  );
  await store.claimDelivery({
    id: event.deliveries[0].id,
    owner: "old",
    leaseMs: 60_000,
  });
  await createSchemaCommandRunner(db, schema)(
    "test.catalog",
    {},
    (_input, { transaction }) =>
      catalog.indexEvent(transaction, {
        namespace: "space",
        operationId: event.event.id,
        eventId: event.event.id,
        position: event.event.position,
        correlationId: event.event.id,
        createdAt: event.event.createdAt,
        metadata: {},
      }),
  );
  // This is a valid accepted logical body whose physical bytes are later lost,
  // not an operation stream referring to an absent logical catalog entry.
  const content = createContentCatalog(db, schema);
  const bodyStore = createDatabaseBodyStore({ session: db, schema });
  const identity = {
    bodyId: "missing-body",
    writerId: "completed-writer",
    generation: 1,
  };
  const bytes = new TextEncoder().encode("completed content");
  const digest = await digestContent(bytes);
  await content.reserve({
    ...identity,
    namespace: "space",
    copy: {
      key: "lost-physical-copy",
      backendKind: bodyStore.kind,
      backendId: bodyStore.backendId,
    },
  });
  const head = await bodyStore.put({
    bodyId: "lost-physical-copy",
    bytes,
    mediaType: "text/plain",
    digest,
  });
  await content.checkpoint({
    ...identity,
    expectedOffset: 0,
    offset: bytes.length,
  });
  await content.sealIntent({ ...identity, length: bytes.length, digest });
  const terminal = await content.sealAccepted({ ...identity, head });
  assertEquals(terminal, {
    outcome: "completed",
    length: bytes.length,
    digest,
  });
  await catalog.openStream({
    namespace: "space",
    operationId: event.event.id,
    semanticStreamId: "lost",
    bodyId: "missing-body",
    descriptor: createStreamOutputDescriptor({
      id: "lost",
      semanticId: "lost",
      mediaType: "text/plain",
      kind: "text",
      role: "assistant",
      metadata: {},
    }, { namespace: "space" }),
  });
  assertEquals(
    await bodyStore.maintenance.delete({
      bodyId: head.bodyId,
      expectedState: "ready",
      expectedVersionToken: head.versionToken,
      expectedMaintenanceVersion: head.maintenanceVersion,
      idleForMs: 0,
    }),
    true,
  );
  assertEquals(await bodyStore.head({ bodyId: head.bodyId }), null);
  assertEquals((await content.read(identity.bodyId))?.terminal, terminal);
  owner.stop();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const session: SqlSession = {
    query: db.query,
    transaction: (run) =>
      db.transaction((tx) =>
        run({
          async query(sql, params) {
            if (sql.includes("SET lease_expires_at=NOW()")) {
              entered.resolve();
              await release.promise;
            }
            return await tx.query(sql, params);
          },
        })
      ),
  };
  let admitted = false;
  const opening = createCopilotzEngine({
    session,
    defaultDatabaseSchema: schema,
    registry: createPluginRegistry({}),
  }).then((engine) => {
    admitted = true;
    return engine;
  });
  try {
    await entered.promise;
    assertEquals(admitted, false);
    release.resolve();
    const engine = await opening;
    try {
      assertEquals(
        (await store.getDelivery(event.deliveries[0].id))?.status,
        "dead_letter",
      );
      const streams = await engine.operations.listStreams({
        namespace: "space",
        operationId: event.event.id,
      });
      assertEquals(streams.length, 1);
      assertEquals(streams[0].availability, "purged");
      assertEquals(streams[0].state, "terminal");
      assertEquals(streams[0].outcome, "completed");
      assertEquals(streams[0].availabilityReason, "missing");
      assertEquals((await content.read(identity.bodyId))?.terminal, terminal);
    } finally {
      await engine.shutdown();
    }
  } finally {
    release.resolve();
    await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.close();
  }
});

Deno.test("an unknown activation commit rejects engine admission", async () => {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL")?.trim() || ":memory:",
  });
  const schema = `activation_unknown_${
    crypto.randomUUID().replaceAll("-", "")
  }`;
  let failed = false;
  const session: SqlSession = {
    query: db.query,
    async transaction(run) {
      let activating = false;
      const result = await db.transaction((tx) =>
        run({
          query(sql, params) {
            if (sql.includes("SET lease_expires_at=NOW()")) activating = true;
            return tx.query(sql, params);
          },
        })
      );
      if (activating) {
        failed = true;
        throw new Error("lost commit acknowledgement");
      }
      return result;
    },
  };
  try {
    await assertRejects(
      () =>
        createCopilotzEngine({
          session,
          defaultDatabaseSchema: schema,
          registry: createPluginRegistry({}),
        }),
      Error,
      "commit outcome is unknown",
    );
    assert(failed);
  } finally {
    await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.close();
  }
});

Deno.test("lazy schema recovery publishes Action terminals without waiting on its own scope", async () => {
  const { createCopilotz, defineAction } = await import("../../index.ts");
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL")?.trim() || ":memory:",
  });
  const schema = `lazy_activation_${crypto.randomUUID().replaceAll("-", "")}`;
  const primarySchema = `${schema}_primary`;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const action = defineAction({
    id: "test.recovery",
    async execute() {
      entered.resolve();
      await release.promise;
      return "late";
    },
  });
  const application = await createCopilotz({
    database: db,
    databaseSchema: schema,
    namespace: "space",
    actions: { recovery: action },
    engine: { maxAttempts: 1 },
  });
  const running = application.actions.recovery({}, {
    idempotencyKey: "recovery",
  });
  void running.catch(() => undefined);
  await entered.promise;
  (await openDatabaseOwner(db, schema)).stop();
  const engine = await createCopilotzEngine({
    session: db,
    defaultDatabaseSchema: primarySchema,
    registry: withApplicationIngress(
      createPluginRegistry({ actions: { recovery: action } }),
    ),
  });
  let opened = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const scope = await Promise.race([
      engine.databaseScope(schema).then((scope) => {
        opened = true;
        return scope;
      }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () =>
            reject(new Error("Recovery publication waited on its own schema")),
          5_000,
        );
      }),
    ]);
    const events = await scope.events.list({ namespace: "space" });
    const terminals = [];
    for (const event of events) {
      const data = (await scope.events.resolve("space", event.id))?.data as {
        actionId?: string;
        status?: string;
      };
      if (data.actionId === action.id && data.status === "failed") {
        terminals.push(event.id);
      }
    }
    assertEquals(terminals.length, 1);
  } finally {
    clearTimeout(timeout);
    release.resolve();
    await application.close();
    if (opened) await engine.shutdown();
    await db.query(`DROP SCHEMA IF EXISTS "${primarySchema}" CASCADE`);
    await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.close();
  }
});
