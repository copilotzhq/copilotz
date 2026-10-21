import { stageOwnerChange } from "../events/push.ts";
import { createSchemaCommandRunner } from "../engine/commands.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  createEventStore,
  createSqlSession,
  provisionCopilotzSchema,
} from "../events/index.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import {
  createOperationCatalog,
  provisionOperationCatalog,
  upgradeOperationCatalog,
  validateOperationCatalog,
} from "./catalog.ts";

const POSTGRES_URL = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL")?.trim();
const indexed = (
  operationId: string,
  eventId = operationId,
  position = "1",
  keys?: readonly string[],
) => ({
  namespace: "tenant-a",
  operationId,
  eventId,
  position,
  correlationId: `correlation-${operationId}`,
  createdAt: "2026-10-06T00:00:00Z",
  metadata: keys === undefined ? {} : { observationKeys: keys },
});

async function runSelectionFixture(url: string) {
  const db = await createTestDatabase({ url });
  const schema = `catalog_selection_${crypto.randomUUID().replaceAll("-", "")}`;
  try {
    await provisionCopilotzSchema(db, schema);
    const tables = await provisionOperationCatalog(db, schema);
    const catalog = createOperationCatalog(db, schema);
    const events = createEventStore({
      session: db,
      schema,
      indexOperationEventSql: (input, param) =>
        catalog.indexEventSql(input, param),
    });
    const root = await events.append({
      namespace: "tenant-a",
      type: "generic.work",
      payload: {},
      metadata: { observationKeys: ["account:opaque", "account:opaque"] },
    });
    assertEquals(
      await catalog.getSelectionHeads({
        namespace: "tenant-a",
        selectionKeys: ["account:opaque", "absent"],
      }),
      [{ selectionKey: "account:opaque", changeOrdinal: "1" }],
    );
    const child = await events.append({
      namespace: "tenant-a",
      type: "generic.work",
      settlementScopeId: root.event.id,
      payload: {},
      metadata: { observationKeys: ["topic:opaque"] },
    });
    const descendant = await events.append({
      namespace: "tenant-a",
      type: "generic.work",
      settlementScopeId: root.event.id,
      payload: {},
      metadata: {},
    });
    assertEquals(
      await catalog.listOperationEventIds({
        namespace: "tenant-a",
        operationId: root.event.id,
      }),
      [{ eventId: root.event.id, eventOrdinal: "1" }, {
        eventId: child.event.id,
        eventOrdinal: "2",
      }, { eventId: descendant.event.id, eventOrdinal: "3" }],
    );
    assertEquals(
      await catalog.getSelectionHeads({
        namespace: "tenant-a",
        selectionKeys: ["account:opaque"],
      }),
      [{ selectionKey: "account:opaque", changeOrdinal: "3" }],
    );
    assertEquals(
      await catalog.getSelectionHeads({
        namespace: "tenant-a",
        selectionKeys: ["topic:opaque"],
      }),
      [{ selectionKey: "topic:opaque", changeOrdinal: "2" }],
    );
    const changes = await catalog.listSelectionChanges({
      namespace: "tenant-a",
      selectionKey: "topic:opaque",
      afterChangeOrdinal: "0",
    });
    assertEquals(changes.length, 1);
    assertEquals(changes[0].operationId, root.event.id);
    assertEquals(changes[0].state, "running");
    assertEquals(changes[0].changeOrdinal, "2");
    assertEquals(
      await catalog.listSelectionChanges({
        namespace: "tenant-b",
        selectionKey: "account:opaque",
      }),
      [],
    );
    assertEquals(
      await catalog.listSelectionChanges({
        namespace: "tenant-a",
        selectionKey: "account:opaque",
        operationIds: ["unrelated"],
      }),
      [],
    );
    assertEquals(
      await catalog.listSelectionChanges({
        namespace: "tenant-a",
        selectionKey: "account:opaque",
        afterChangeOrdinal: "3",
      }),
      [],
    );
    await createSchemaCommandRunner(db, schema)(
      "test.mutation",
      {},
      (_input, { transaction: tx }) =>
        catalog.indexEvent(
          tx,
          indexed(root.event.id, child.event.id, "2", [
            "not-added-by-duplicate",
          ]),
        ),
    );
    assertEquals(
      await catalog.getSelectionHeads({
        namespace: "tenant-a",
        selectionKeys: ["account:opaque", "not-added-by-duplicate"],
      }),
      [{ selectionKey: "account:opaque", changeOrdinal: "3" }],
    );
    await assertRejects(
      () =>
        createSchemaCommandRunner(db, schema)(
          "test.mutation",
          {},
          async (_input, { transaction: tx }) => {
            await catalog.indexEvent(
              tx,
              indexed("rollback", "rollback", "50", ["account:opaque"]),
            );
            throw new Error("rollback");
          },
        ),
      Error,
      "rollback",
    );
    assertEquals(await catalog.get("tenant-a", "rollback"), null);
    assertEquals(
      (await catalog.getSelectionHeads({
        namespace: "tenant-a",
        selectionKeys: ["account:opaque"],
      }))[0].changeOrdinal,
      "3",
    );
    // Domain metadata has no implicit meaning to this generic runtime.
    await events.append({
      namespace: "tenant-a",
      type: "generic.work",
      payload: {},
      metadata: { threadId: "account:opaque" },
    });
    assertEquals(
      (await catalog.listSelectionChanges({
        namespace: "tenant-a",
        selectionKey: "account:opaque",
      })).length,
      1,
    );
    const counts = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${tables.selectionOperations}`,
    );
    assertEquals(counts.rows[0].count, "2");
    await assertRejects(
      () =>
        catalog.listOperationEventIds({
          namespace: "tenant-a",
          operationId: root.event.id,
          afterEventOrdinal: "1.5",
        }),
      TypeError,
    );
    await assertRejects(
      () =>
        createSchemaCommandRunner(db, schema)(
          "test.mutation",
          {},
          (_input, { transaction: tx }) =>
            catalog.indexEvent(tx, {
              ...indexed("invalid"),
              metadata: { observationKeys: [1] },
            }),
        ),
      TypeError,
    );
  } finally {
    await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.close();
  }
}

Deno.test("indexed selections preserve generic associations, idempotence and transaction rollback", () =>
  runSelectionFixture(":memory:"));
Deno.test({
  name:
    "indexed selections work through sibling inserted_event CTE on PostgreSQL",
  ignore: !POSTGRES_URL,
  fn: () => runSelectionFixture(POSTGRES_URL!),
});

Deno.test("owner push never crosses schema or explicitly scoped namespace", async () => {
  const session = await createTestDatabase({ url: ":memory:" });
  for (const schema of ["schema_a", "schema_b"]) {
    await provisionCopilotzSchema(session, schema);
    await provisionOperationCatalog(session, schema);
  }
  const first = createOperationCatalog(session, "schema_a");
  const second = createOperationCatalog(session, "schema_b");
  const received: string[] = [];
  const removeA = await first.onChange((id, detail) => {
    if (id) {
      received.push(
        `a:${detail.namespace}:${id}:${detail.selectionKeys.join()}:${detail.kind}`,
      );
    }
  }, { namespace: "scope" });
  const removeB = await second.onChange((id) => {
    if (id) received.push(`b:${id}`);
  }, { namespace: "scope" });
  const watch = await first.watch("same-id", { namespace: "scope" });
  const deliver = (schema: string, namespace: string) =>
    createSchemaCommandRunner(session, schema)(
      "test.push",
      {},
      (_input, { transaction }) => {
        stageOwnerChange(transaction, schema, {
          namespace,
          operationId: "same-id",
          selectionKeys: ["opaque"],
          kind: "event",
          seq: "0",
        });
      },
    );
  try {
    await deliver("schema_a", "other");
    await deliver("schema_b", "scope");
    assertEquals(await watch.wait({ timeoutMs: 100 }), false);
    await deliver("schema_a", "scope");
    assertEquals(await watch.wait({ timeoutMs: 100 }), true);
    assertEquals(received, ["b:same-id", "a:scope:same-id:opaque:event"]);
    await assertRejects(
      () =>
        createSchemaCommandRunner(session, "schema_a")(
          "test.invalid",
          {},
          (_input, { transaction }) => {
            stageOwnerChange(transaction, "schema_a", {
              namespace: "scope",
              operationId: "same-id",
              selectionKeys: [],
              kind: "stream-offset",
              seq: "0",
              streamId: "stream",
              committedOffset: -1,
            });
          },
        ),
      TypeError,
    );
    assertEquals(received.length, 2);
  } finally {
    removeA();
    removeB();
    watch.close();
    await session.close();
  }
});

Deno.test("offline catalog upgrade backfills opaque domain keys and event ordinals", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const schema = "catalog_selection_upgrade";
  try {
    await provisionCopilotzSchema(db, schema);
    const tables = await provisionOperationCatalog(db, schema);
    const catalog = createOperationCatalog(db, schema);
    const events = createEventStore({
      session: db,
      schema,
      indexOperationEvent: (tx, input) => catalog.indexEvent(tx, input),
    });
    const root = await events.append({
      namespace: "tenant-a",
      type: "generic.work",
      payload: {},
      metadata: { accountId: "legacy" },
    });
    const child = await events.append({
      namespace: "tenant-a",
      type: "generic.work",
      payload: {},
      settlementScopeId: root.event.id,
      metadata: { accountId: "other" },
    });
    // Reconstruct historical metadata offline; current admission is bounded.
    await db.transaction(async (transaction) => {
      await transaction.query(
        `ALTER TABLE "${schema}".events DISABLE TRIGGER copilotz_events_immutable`,
      );
      await transaction.query(
        `UPDATE "${schema}".events SET metadata=$2::jsonb WHERE id=$1`,
        [
          root.event.id,
          JSON.stringify({
            accountId: "legacy",
            ignored: "x".repeat(2 * 1024 * 1024),
          }),
        ],
      );
      await transaction.query(
        `ALTER TABLE "${schema}".events ENABLE TRIGGER copilotz_events_immutable`,
      );
    });
    await db.query(
      `DROP TABLE ${tables.selectionOperations}, ${tables.selectionHeads}`,
    );
    await db.query(
      `ALTER TABLE ${tables.operations} DROP COLUMN next_event_ordinal, DROP COLUMN observation_keys`,
    );
    await db.query(
      `ALTER TABLE ${tables.operationEvents} DROP COLUMN event_ordinal`,
    );
    await db.query(
      `ALTER TABLE ${tables.metadata} DROP CONSTRAINT copilotz_operation_catalog_metadata_fingerprint_check`,
    );
    await db.query(`ALTER TABLE ${tables.operationStreams}
      ADD COLUMN committed_offset BIGINT NOT NULL DEFAULT 0, ADD COLUMN digest TEXT`);
    await db.query(
      `UPDATE ${tables.metadata} SET fingerprint = 'retained-terminal-streams'`,
    );
    await db.query(
      `ALTER TABLE ${tables.metadata} ADD CONSTRAINT copilotz_operation_catalog_metadata_fingerprint_check CHECK (fingerprint = 'retained-terminal-streams')`,
    );
    await assertRejects(
      () => provisionOperationCatalog(db, schema),
      Error,
      "explicit offline upgrade",
    );
    await assertRejects(() => validateOperationCatalog(db, schema));
    await assertRejects(
      () =>
        upgradeOperationCatalog(db, schema, {
          backfillMetadataKeys: ["accountId"],
          resolveObservationKeys() {
            throw new Error("resolver rejected");
          },
        }),
      Error,
      "resolver rejected",
    );
    assertEquals(
      (await db.query<{ fingerprint: string }>(
        `SELECT fingerprint FROM ${tables.metadata}`,
      )).rows[0].fingerprint,
      "retained-terminal-streams",
    );
    assertEquals(
      (await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'copilotz_operation_events' AND column_name = 'event_ordinal'`,
        [schema],
      )).rows[0].count,
      "0",
    );
    const projected: string[][] = [];
    await upgradeOperationCatalog(db, schema, {
      backfillMetadataKeys: ["accountId", "quote'key"],
      resolveObservationKeys: ({ metadata }) => {
        projected.push(Object.keys(metadata));
        return typeof metadata.accountId === "string"
          ? [`account:${metadata.accountId}`]
          : [];
      },
    });
    assert(projected.every((keys) => keys.every((key) => key === "accountId")));
    await validateOperationCatalog(db, schema);
    assertEquals(
      (await catalog.listSelectionChanges({
        namespace: "tenant-a",
        selectionKey: "account:legacy",
      }))[0].operationId,
      root.event.id,
    );
    assertEquals(
      (await catalog.listSelectionChanges({
        namespace: "tenant-a",
        selectionKey: "account:other",
      }))[0].operationId,
      root.event.id,
    );
    assertEquals(
      await catalog.listOperationEventIds({
        namespace: "tenant-a",
        operationId: root.event.id,
      }),
      [{ eventId: root.event.id, eventOrdinal: "1" }, {
        eventId: child.event.id,
        eventOrdinal: "2",
      }],
    );
    await events.append({
      namespace: "tenant-a",
      type: "generic.work",
      payload: {},
      settlementScopeId: root.event.id,
      metadata: {},
    });
    assertEquals(
      (await catalog.listOperationEventIds({
        namespace: "tenant-a",
        operationId: root.event.id,
        afterEventOrdinal: "2",
      }))[0].eventOrdinal,
      "3",
    );
    await upgradeOperationCatalog(db, schema);
    assertEquals(
      (await catalog.getSelectionHeads({
        namespace: "tenant-a",
        selectionKeys: ["account:other"],
      }))[0].changeOrdinal,
      "2",
    );
  } finally {
    await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.close();
  }
});

Deno.test({
  name:
    "PostgreSQL concurrent owner contexts preserve selection and operation cursor order",
  ignore: !POSTGRES_URL,
  fn: async () => {
    const db = await createTestDatabase({ url: POSTGRES_URL! });
    const writer = createSqlSession(db);
    const observer = await createTestDatabase({ url: POSTGRES_URL! });
    const schema = `catalog_ordering_${
      crypto.randomUUID().replaceAll("-", "")
    }`;
    const catalog = createOperationCatalog(db, schema);
    try {
      await provisionCopilotzSchema(db, schema);
      await provisionOperationCatalog(db, schema);
      await createSchemaCommandRunner(db, schema)(
        "test.mutation",
        {},
        (_input, { transaction: tx }) =>
          catalog.indexEvent(tx, indexed("root", "root", "100", ["opaque"])),
      );
      const challenge = async (
        firstOperation: string,
        firstEvent: string,
        secondOperation: string,
        secondEvent: string,
        firstPosition: string,
        secondPosition: string,
      ) => {
        let ready!: () => void;
        const started = new Promise<void>((resolve) => ready = resolve);
        let release!: () => void;
        const allowed = new Promise<void>((resolve) => release = resolve);
        const before = (await catalog.getSelectionHeads({
          namespace: "tenant-a",
          selectionKeys: ["opaque"],
        }))[0].changeOrdinal;
        const first = createSchemaCommandRunner(db, schema)(
          "test.mutation",
          {},
          async (_input, { transaction: tx }) => {
            await catalog.indexEvent(
              tx,
              indexed(firstOperation, firstEvent, firstPosition, ["opaque"]),
            );
            ready();
            await allowed;
          },
        );
        await started;
        let secondCommitted = false;
        const second = createSchemaCommandRunner(writer, schema)(
          "test.mutation",
          {},
          async (_input, { transaction: tx }) => {
            await catalog.indexEvent(
              tx,
              indexed(secondOperation, secondEvent, secondPosition, ["opaque"]),
            );
          },
        ).then(() => {
          secondCommitted = true;
        });
        try {
          await new Promise((resolve) => setTimeout(resolve, 75));
          assertEquals(
            secondCommitted,
            false,
            "later commands must wait for the earlier commit",
          );
          assertEquals(
            (await observer.query<{ change_ordinal: string }>(
              `SELECT change_ordinal::text FROM "${schema}".copilotz_operation_selection_heads WHERE namespace = 'tenant-a' AND selection_key = 'opaque'`,
            )).rows[0].change_ordinal,
            before,
          );
        } finally {
          release();
        }
        await first;
        await second;
        const changed = await catalog.listSelectionChanges({
          namespace: "tenant-a",
          selectionKey: "opaque",
          afterChangeOrdinal: before,
        });
        assert(changed.some((row) => row.operationId === firstOperation));
        assert(changed.some((row) => row.operationId === secondOperation));
      };
      // Adapters of one database instance share the owner queue; the independent
      // observer sees only committed state. Global positions deliberately run
      // backwards relative to the commit order.
      await challenge(
        "first-root",
        "first-root",
        "second-root",
        "second-root",
        "300",
        "200",
      );
      // Same operation contends on its local event allocator as well.
      await challenge("root", "event-a", "root", "event-b", "500", "400");
      assertEquals(
        await catalog.listOperationEventIds({
          namespace: "tenant-a",
          operationId: "root",
          afterEventOrdinal: "1",
        }),
        [{ eventId: "event-a", eventOrdinal: "2" }, {
          eventId: "event-b",
          eventOrdinal: "3",
        }],
      );
      await Promise.all([
        createSchemaCommandRunner(db, schema)(
          "test.mutation",
          {},
          (_input, { transaction: tx }) =>
            catalog.indexEvent(
              tx,
              indexed("multi-a", "multi-a", "600", ["z", "a"]),
            ),
        ),
        createSchemaCommandRunner(writer, schema)(
          "test.mutation",
          {},
          (_input, { transaction: tx }) =>
            catalog.indexEvent(
              tx,
              indexed("multi-b", "multi-b", "700", ["a", "z"]),
            ),
        ),
      ]);
      assertEquals(
        (await catalog.getSelectionHeads({
          namespace: "tenant-a",
          selectionKeys: ["a", "z"],
        })).map((row) => row.changeOrdinal),
        ["2", "2"],
      );
    } finally {
      await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await db.close();
      await observer.close();
    }
  },
});

Deno.test({
  name:
    "PostgreSQL sibling event indexing pushes scoped changes only after outer commit",
  ignore: !POSTGRES_URL,
  fn: async () => {
    const db = await createTestDatabase({ url: POSTGRES_URL! });
    // Owner notifications share the writer lifetime through a supported adapter.
    const observer = createSqlSession(db);
    const schema = `catalog_hints_${crypto.randomUUID().replaceAll("-", "")}`;
    let release: (() => void) | undefined;
    let writing: Promise<void> | undefined;
    try {
      await provisionCopilotzSchema(db, schema);
      await provisionOperationCatalog(db, schema);
      const writerCatalog = createOperationCatalog(db, schema);
      const watchingCatalog = createOperationCatalog(observer, schema);
      const hints: string[] = [];
      const unsubscribe = await watchingCatalog.onChange(
        (operationId, detail) => {
          if (operationId) {
            hints.push(
              `${operationId}:${detail.namespace}:${detail.selectionKeys.join()}:${detail.kind}`,
            );
          }
        },
        { namespace: "tenant-a" },
      );
      const watch = await watchingCatalog.watch("root", {
        namespace: "tenant-a",
      });
      let ready!: () => void;
      const indexed = new Promise<void>((resolve) => ready = resolve);
      const allowed = new Promise<void>((resolve) => release = resolve);
      writing = createSchemaCommandRunner(db, schema)(
        "test.mutation",
        {},
        async (_input, { transaction: tx }) => {
          const events = createEventStore({
            session: db,
            schema,
            createId: () => "root",
            indexOperationEventSql: (input, param) =>
              writerCatalog.indexEventSql(input, param),
          });
          await events.commitMutation({
            draft: {
              namespace: "tenant-a",
              type: "generic.work",
              payload: {},
              metadata: { observationKeys: ["opaque"] },
            },
            consumers: [],
            transaction: tx,
          });
          ready();
          await allowed;
        },
      );
      await indexed;
      assertEquals(await watch.wait({ timeoutMs: 100 }), false);
      release!();
      await writing;
      writing = undefined;
      assertEquals(await watch.wait({ timeoutMs: 2000 }), true);
      assertEquals(hints, ["root:tenant-a:opaque:event"]);
      await assertRejects(
        () =>
          createSchemaCommandRunner(db, schema)(
            "test.mutation",
            {},
            async (_input, { transaction: tx }) => {
              await writerCatalog.indexEvent(tx, {
                ...indexedInput(),
                eventId: "rolled-back",
                position: "2",
              });
              throw new Error("rollback");
            },
          ),
        Error,
        "rollback",
      );
      assertEquals(await watch.wait({ timeoutMs: 100 }), false);
      watch.close();
      unsubscribe();
    } finally {
      release?.();
      await writing?.catch(() => undefined);
      await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await db.close();
    }
    function indexedInput() {
      return indexed("root", "root", "1", ["opaque"]);
    }
  },
});
