import { assertEquals, assertRejects } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import {
  createEventStore,
  provisionCopilotzSchema,
  type SqlSession,
  validateCopilotzSchema,
} from "../events/index.ts";
import {
  createOperationCatalog,
  provisionOperationCatalog,
  validateOperationCatalog,
} from "../streams/catalog.ts";
import {
  createCoreTableNames,
  EVENT_SCHEMA_VERSION,
} from "../events/schema.ts";
import { upgradeActionLifecycle } from "./upgrade.ts";

async function fixture(active = false) {
  const db = await createTestDatabase({ url: ":memory:" });
  const schema = "action_upgrade";
  await provisionCopilotzSchema(db, schema);
  const catalogTables = await provisionOperationCatalog(db, schema);
  const catalog = createOperationCatalog(db, schema);
  const store = createEventStore({
    session: db,
    schema,
    admitOperationEventSql: (input, param) =>
      catalog.admitEventSql(input, param),
    indexOperationEventSql: (input, param) =>
      catalog.indexEventSql(input, param),
  });
  const root = await store.append({
    namespace: "space",
    type: "existing.work",
    payload: { retained: true },
  }, active ? ["worker"] : []);
  if (!active) await catalog.reconcile();
  await db.query(`DROP TABLE ${store.tables.open_actions}`);
  await db.query(
    `ALTER TABLE ${store.tables.event_deliveries} DROP COLUMN action_scope_id`,
  );
  await db.query(
    `ALTER TABLE ${catalogTables.operations} DROP COLUMN visibility, DROP COLUMN cancellation_requested_at, DROP COLUMN cancellation_reason,
    ADD CONSTRAINT copilotz_operations_root_event_id_key UNIQUE (root_event_id)`,
  );
  await db.query(
    `ALTER TABLE ${catalogTables.metadata} DROP CONSTRAINT copilotz_operation_catalog_metadata_fingerprint_check`,
  );
  await db.query(
    `UPDATE ${catalogTables.metadata} SET fingerprint = 'indexed-observation-ordinals-v1'`,
  );
  await db.query(
    `ALTER TABLE ${catalogTables.metadata} ADD CONSTRAINT copilotz_operation_catalog_metadata_fingerprint_check CHECK (fingerprint = 'indexed-observation-ordinals-v1')`,
  );
  await db.query(
    `UPDATE ${store.tables.copilotz_schema_metadata} SET version = 5`,
  );
  return { db, schema, store, root, catalogTables };
}

Deno.test("offline lifecycle upgrade preserves immutable history and is repeatable", async () => {
  const f = await fixture();
  try {
    const before = await f.db.query(
      `SELECT * FROM ${f.store.tables.events} ORDER BY position`,
    );
    await upgradeActionLifecycle(f.db, f.schema);
    await upgradeActionLifecycle(f.db, f.schema);
    await validateCopilotzSchema(f.db, f.schema);
    await validateOperationCatalog(f.db, f.schema);
    assertEquals(
      (await f.db.query(
        `SELECT * FROM ${f.store.tables.events} ORDER BY position`,
      )).rows,
      before.rows,
    );
    assertEquals(
      (await f.db.query(`SELECT * FROM ${f.store.tables.open_actions}`)).rows,
      [],
    );
  } finally {
    await f.db.close();
  }
});

Deno.test("offline lifecycle upgrade refuses in-flight old work without partial DDL", async () => {
  const f = await fixture(true);
  try {
    await assertRejects(
      () => upgradeActionLifecycle(f.db, f.schema),
      Error,
      "Drain existing",
    );
    assertEquals(
      (await f.db.query(
        `SELECT version FROM ${f.store.tables.copilotz_schema_metadata}`,
      )).rows[0].version,
      5,
    );
    assertEquals(
      (await f.db.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND column_name = 'action_scope_id'`,
        [f.schema],
      )).rows,
      [],
    );
  } finally {
    await f.db.close();
  }
});

Deno.test("lifecycle migration rolls both schema markers and all DDL back on failure", async () => {
  const f = await fixture();
  const failing: SqlSession = {
    ...f.db,
    transaction: (run) =>
      f.db.transaction((tx) =>
        run({
          query(sql, params) {
            if (sql.includes("SET version = $1")) {
              throw new Error("injected upgrade failure");
            }
            return tx.query(sql, params);
          },
        })
      ),
  };
  try {
    await assertRejects(
      () => upgradeActionLifecycle(failing, f.schema),
      Error,
      "injected upgrade failure",
    );
    assertEquals(
      (await f.db.query(
        `SELECT version FROM ${f.store.tables.copilotz_schema_metadata}`,
      )).rows[0].version,
      5,
    );
    assertEquals(
      (await f.db.query(`SELECT fingerprint FROM ${f.catalogTables.metadata}`))
        .rows[0].fingerprint,
      "indexed-observation-ordinals-v1",
    );
    assertEquals(
      (await f.db.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND column_name = 'action_scope_id'`,
        [f.schema],
      )).rows,
      [],
    );
    await upgradeActionLifecycle(f.db, f.schema);
  } finally {
    await f.db.close();
  }
});

Deno.test("additive owner upgrade preserves active obligations and immutable history", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const schema = "owner_lifecycle_upgrade";
  const tables = createCoreTableNames(schema);
  try {
    await provisionCopilotzSchema(db, schema);
    await provisionOperationCatalog(db, schema);
    const store = createEventStore({ session: db, schema });
    const event = await store.append({
      namespace: "space",
      type: "existing.work",
      payload: {},
    }, ["worker"]);
    await db.query(
      `INSERT INTO ${tables.open_actions}
      (namespace,action_run_id,action_id,scope_id,invoked_event_id,state,await_event_id,child_operation_id)
      VALUES ('space','run','action','scope',$1,'awaiting',$1,'child')`,
      [event.event.id],
    );
    await db.query(
      `DROP TABLE ${tables.owner_event_sequences}, ${tables.owner_body_retirements}, ${tables.owner_alarms}, ${tables.owner_receipts}, ${tables.owner_epochs}`,
    );
    await db.query(`UPDATE ${tables.copilotz_schema_metadata} SET version = 8`);
    const history = (await db.query(`SELECT * FROM ${tables.events}`)).rows;
    const obligations =
      (await db.query(`SELECT * FROM ${tables.open_actions}`)).rows;
    await upgradeActionLifecycle(db, schema);
    await upgradeActionLifecycle(db, schema);
    assertEquals(
      (await validateCopilotzSchema(db, schema)).version,
      EVENT_SCHEMA_VERSION,
    );
    assertEquals(
      (await db.query(`SELECT * FROM ${tables.events}`)).rows,
      history,
    );
    assertEquals(
      (await db.query(`SELECT * FROM ${tables.open_actions}`)).rows,
      obligations,
    );
  } finally {
    await db.close();
  }
});

for (const baseline of [6, 7]) {
  Deno.test(`offline obligation upgrade preserves history from baseline ${baseline}`, async () => {
    const db = await createTestDatabase({ url: ":memory:" });
    const schema = "obligation_upgrade";
    const tables = createCoreTableNames(schema);
    try {
      await provisionCopilotzSchema(db, schema);
      await provisionOperationCatalog(db, schema);
      const store = createEventStore({ session: db, schema });
      await store.append({
        namespace: "space",
        type: "existing.work",
        payload: { kept: true },
      }, []);
      await db.query(
        `DROP TABLE ${tables.open_actions}, ${tables.owner_event_sequences}, ${tables.owner_body_retirements}, ${tables.owner_alarms}, ${tables.owner_receipts}, ${tables.owner_epochs}`,
      );
      await db.query(
        `CREATE TABLE ${tables.open_actions} (action_run_id TEXT PRIMARY KEY, state TEXT, deferred_event_id TEXT)`,
      );
      await db.query(
        `UPDATE ${tables.copilotz_schema_metadata} SET version = $1`,
        [baseline],
      );
      const history = (await db.query(`SELECT * FROM ${tables.events}`)).rows;
      await upgradeActionLifecycle(db, schema);
      assertEquals(
        (await validateCopilotzSchema(db, schema)).version,
        EVENT_SCHEMA_VERSION,
      );
      assertEquals(
        (await db.query(`SELECT * FROM ${tables.events}`)).rows,
        history,
      );
    } finally {
      await db.close();
    }
  });
}
