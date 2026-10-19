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
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") || ":memory:",
  });
  const schema = `action_upgrade_${crypto.randomUUID().replaceAll("-", "")}`;
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
  await db.query(`ALTER TABLE ${catalogTables.operationStreams}
    ADD COLUMN committed_offset BIGINT NOT NULL DEFAULT 0, ADD COLUMN digest TEXT`);
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
    await f.db.query(`DROP SCHEMA "${f.schema}" CASCADE`);
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
    await f.db.query(`DROP SCHEMA "${f.schema}" CASCADE`);
    await f.db.close();
  }
});

Deno.test("failed finalization keeps the prepared non-ready marker and resumes", async () => {
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
      0,
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
    await f.db.query(`DROP SCHEMA "${f.schema}" CASCADE`);
    await f.db.close();
  }
});

Deno.test("offline owner upgrade refuses active obligations without changing history", async () => {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") || ":memory:",
  });
  const schema = `owner_upgrade_${crypto.randomUUID().replaceAll("-", "")}`;
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
    await db.query(`UPDATE ${tables.copilotz_schema_metadata} SET version = 8`);
    const history = (await db.query(`SELECT * FROM ${tables.events}`)).rows;
    const obligations =
      (await db.query(`SELECT * FROM ${tables.open_actions}`)).rows;
    await assertRejects(
      () => upgradeActionLifecycle(db, schema),
      Error,
      "Drain existing",
    );
    assertEquals(
      (await db.query(`SELECT * FROM ${tables.events}`)).rows,
      history,
    );
    assertEquals(
      (await db.query(`SELECT * FROM ${tables.open_actions}`)).rows,
      obligations,
    );
    assertEquals(
      (await db.query(`SELECT version FROM ${tables.copilotz_schema_metadata}`))
        .rows[0].version,
      8,
    );
    await db.query(`DELETE FROM ${tables.open_actions}`);
    await db.query(`UPDATE ${tables.event_deliveries} SET status='cancelled'`);
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
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    await db.close();
  }
});

for (const baseline of [6, 7]) {
  Deno.test(`offline obligation upgrade preserves history from baseline ${baseline}`, async () => {
    const db = await createTestDatabase({
      url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") || ":memory:",
    });
    const schema = `obligation_upgrade_${
      crypto.randomUUID().replaceAll("-", "")
    }`;
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
        `DROP TABLE ${tables.open_actions}`,
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
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.close();
    }
  });
}

for (const baseline of [8, 9]) {
  Deno.test(`retained owner v${baseline} requires offline upgrade and preserves durable owner state`, async () => {
    const db = await createTestDatabase({
      url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") || ":memory:",
    });
    const schema = `owner_upgrade_${crypto.randomUUID().replaceAll("-", "")}`;
    const tables = createCoreTableNames(schema);
    try {
      // Supplemental shape fixture. The separate retained-upgrade test restores
      // genuine pre-conversion data generated by the exact historical checkout.
      await provisionCopilotzSchema(db, schema);
      await provisionOperationCatalog(db, schema);
      await createEventStore({ session: db, schema }).append({
        namespace: "space",
        type: "retained.owner.event",
        payload: { retained: true },
      });
      await db.query(
        `INSERT INTO ${tables.owner_receipts}(owner,domain,key,principal,kind,intent,result)
         VALUES('schema','logical','retained-receipt','fixture','mutation','{}','{"confirmed":true}')`,
      );
      await db.query(
        `INSERT INTO ${tables.owner_body_retirements}(owner,backend_kind,backend_id,body_id,token,completed)
         VALUES('schema','database','database:default','retained-retirement','retained-token',TRUE)`,
      );
      const receipts = (await db.query(
        `SELECT owner,domain,key,principal,kind,intent,result FROM ${tables.owner_receipts}`,
      )).rows;
      const retirements =
        (await db.query(`SELECT * FROM ${tables.owner_body_retirements}`)).rows;
      await db.query(`DROP INDEX "${schema}".owner_alarms_owner_idx`);
      await db.query(
        `INSERT INTO ${tables.owner_alarms}(owner,name,due_at) VALUES
         ('schema','wake','2024-01-02T00:00:00Z'),('schema','retained-work','2024-01-01T00:00:00Z')`,
      );
      const retainedDue = (await db.query(
        `SELECT due_at FROM ${tables.owner_alarms} WHERE name='retained-work'`,
      )).rows[0].due_at;
      for (
        const table of [
          "action_effects",
          "owner_deadlines",
          "content_adoptions",
          "pending_content",
          "content_copies",
          "content_logical_bodies",
        ] as const
      ) await db.query(`DROP TABLE ${tables[table]}`);
      await db.query(`ALTER TABLE ${tables.events} DROP COLUMN seq`);
      await db.query(
        `UPDATE ${tables.copilotz_schema_metadata} SET version=$1`,
        [baseline],
      );
      const history =
        (await db.query(`SELECT * FROM ${tables.events} ORDER BY position`))
          .rows;
      await assertRejects(
        () => provisionCopilotzSchema(db, schema),
        Error,
        "offline retained-data upgrade",
      );
      assertEquals(
        (await db.query(
          `SELECT version FROM ${tables.copilotz_schema_metadata}`,
        )).rows[0].version,
        baseline,
      );
      assertEquals(
        (await db.query(`SELECT * FROM ${tables.events} ORDER BY position`))
          .rows,
        history,
      );
      await upgradeActionLifecycle(db, schema);
      await upgradeActionLifecycle(db, schema);
      await provisionCopilotzSchema(db, schema);
      assertEquals(
        (await validateCopilotzSchema(db, schema)).version,
        EVENT_SCHEMA_VERSION,
      );
      assertEquals(
        (await db.query(`SELECT * FROM ${tables.events} ORDER BY position`))
          .rows.map(({ seq: _seq, ...event }) => event),
        history,
      );
      assertEquals(
        (await db.query(
          `SELECT owner,domain,key,principal,kind,intent,result FROM ${tables.owner_receipts}`,
        )).rows,
        receipts,
      );
      assertEquals(
        (await db.query(`SELECT * FROM ${tables.owner_body_retirements}`)).rows,
        retirements,
      );
      assertEquals(
        (await db.query(`SELECT name FROM ${tables.owner_alarms}`)).rows,
        [{ name: "wake" }],
      );
      const deadline = (await db.query(
        `SELECT * FROM ${tables.owner_deadlines} WHERE key='retained-work'`,
      )).rows[0];
      assertEquals(deadline.source, "reconciliation");
      assertEquals(deadline.due_at, retainedDue);
      await db.query(
        `DELETE FROM ${tables.owner_deadlines} WHERE key='retained-work'`,
      );
      const recreated = (await db.query(
        `INSERT INTO ${tables.owner_deadlines}(owner,source,key,due_at) VALUES('schema','reconciliation','retained-work',$1) RETURNING revision`,
        [retainedDue],
      )).rows[0];
      assertEquals(
        Number(recreated.revision) > Number(deadline.revision),
        true,
      );
      await assertRejects(() =>
        db.query(
          `INSERT INTO ${tables.owner_alarms}(owner,name,due_at) VALUES('schema','duplicate',NOW())`,
        )
      );
      await assertRejects(() =>
        db.query(
          `INSERT INTO ${tables.action_effects}(namespace,action_run_id,step,status) VALUES('space','invalid','step','confirmed')`,
        )
      );
      assertEquals(
        (await db.query(
          `SELECT last_seq FROM ${tables.owner_epochs} WHERE owner='schema'`,
        )).rows[0].last_seq,
        "1",
      );
      assertEquals(
        (await db.query(
          `SELECT COUNT(*)::integer AS count FROM ${tables.owner_event_sequences}`,
        )).rows[0].count,
        1,
      );
    } finally {
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.close();
    }
  });
}
