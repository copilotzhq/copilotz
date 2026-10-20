import { testUpgradeOptions } from "../testing/upgrade.ts";
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
  return {
    db,
    schema,
    store,
    root,
    catalogTables,
    options: await testUpgradeOptions(db, schema),
  };
}

Deno.test("offline lifecycle upgrade preserves immutable history and is repeatable", async () => {
  const f = await fixture();
  try {
    const before = await f.db.query(
      `SELECT * FROM ${f.store.tables.events} ORDER BY position`,
    );
    await upgradeActionLifecycle(f.db, f.schema, f.options);
    await upgradeActionLifecycle(f.db, f.schema, f.options);
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
      () => upgradeActionLifecycle(f.db, f.schema, f.options),
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
      () => upgradeActionLifecycle(failing, f.schema, f.options),
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
    await upgradeActionLifecycle(f.db, f.schema, f.options);
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
    await upgradeActionLifecycle(
      db,
      schema,
      await testUpgradeOptions(db, schema),
    );
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
      await upgradeActionLifecycle(
        db,
        schema,
        await testUpgradeOptions(db, schema),
      );
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

for (const baseline of [8, 9, 10]) {
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
        `SELECT owner,domain,key,principal,kind,intent,result FROM ${tables.owner_receipts} WHERE key NOT IN ('owner-keys-upgrade:12','authorization-upgrade:13')`,
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
      await upgradeActionLifecycle(
        db,
        schema,
        await testUpgradeOptions(db, schema),
      );
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
          `SELECT owner,domain,key,principal,kind,intent,result FROM ${tables.owner_receipts} WHERE key NOT IN ('owner-keys-upgrade:12','authorization-upgrade:13')`,
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
        Number(
          (await db.query(
            `SELECT last_seq FROM ${tables.owner_epochs} WHERE owner='schema'`,
          )).rows[0].last_seq,
        ),
        1,
      );
      assertEquals(
        (await db.query(
          `SELECT COUNT(*)::integer AS count FROM ${tables.events}`,
        )).rows[0].count,
        1,
      );
    } finally {
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.close();
    }
  });
}

Deno.test("linear chain stops at each missing input and resumes the exact reviewed plan", async () => {
  const f = await fixture();
  try {
    for (
      const table of [
        "owner_data_keys",
        "authorization_effects",
        "authorization_sessions",
        "authorization_channels",
        "authorization_invocations",
      ] as const
    ) {
      await f.db.query(`DROP TABLE ${f.store.tables[table]}`);
    }
    const { prepareRetainedDataUpgrade } = await import("./upgrade.ts");
    const { UpgradeStepRequiredError } = await import("./upgrade-errors.ts");
    const plan = (await prepareRetainedDataUpgrade(f.db, f.schema))!;
    assertEquals(plan.targetVersion, 11);
    const reviewed = { plan, reviewedFingerprint: plan.fingerprint };
    const version = async () =>
      Number(
        (await f.db.query<{ version: number }>(
          `SELECT version FROM ${f.store.tables.copilotz_schema_metadata}`,
        )).rows[0].version,
      );
    const keyError = await assertRejects(
      () => upgradeActionLifecycle(f.db, f.schema, reviewed),
      UpgradeStepRequiredError,
    );
    assertEquals(keyError.code, "copilotz_upgrade_owner_keys_required");
    assertEquals([keyError.fromVersion, keyError.toVersion], [11, 12]);
    assertEquals(await version(), 11);
    assertEquals(
      (await f.db.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema=$1 AND (table_name='owner_data_keys' OR table_name LIKE 'authorization_%')`,
        [f.schema],
      )).rows,
      [],
    );
    await assertRejects(
      () =>
        upgradeActionLifecycle(f.db, f.schema, {
          ...reviewed,
          authority: f.options.authority,
        }),
      UpgradeStepRequiredError,
    );
    assertEquals(await version(), 11);
    const keys = { ...reviewed, ownerKeys: f.options.ownerKeys };
    const authorityError = await assertRejects(
      () => upgradeActionLifecycle(f.db, f.schema, keys),
      UpgradeStepRequiredError,
    );
    assertEquals(authorityError.code, "copilotz_upgrade_authority_required");
    assertEquals([authorityError.fromVersion, authorityError.toVersion], [
      12,
      13,
    ]);
    assertEquals(await version(), 12);
    const key =
      (await f.db.query(`SELECT * FROM ${f.store.tables.owner_data_keys}`))
        .rows;
    assertEquals(key.length, 1);
    await assertRejects(
      () => prepareRetainedDataUpgrade(f.db, f.schema),
      UpgradeStepRequiredError,
    );
    await assertRejects(
      () =>
        upgradeActionLifecycle(f.db, f.schema, {
          ...keys,
          contentDecisions: [{
            namespace: "space",
            assetId: "changed",
            ownerId: null,
          }],
        }),
      Error,
      "accepted plan or ownership decisions",
    );
    await upgradeActionLifecycle(f.db, f.schema, {
      ...keys,
      authority: f.options.authority,
    });
    await upgradeActionLifecycle(f.db, f.schema, {
      ...keys,
      authority: f.options.authority,
    });
    assertEquals(await version(), 15);
    assertEquals(
      (await f.db.query(`SELECT * FROM ${f.store.tables.owner_data_keys}`))
        .rows,
      key,
    );
    await assertRejects(
      () =>
        upgradeActionLifecycle(f.db, f.schema, {
          authority: {
            ...f.options.authority,
            policies: [{ id: "changed", revision: "1" }],
          },
        }),
      Error,
      "accepted manifest",
    );
  } finally {
    await f.db.query(`DROP SCHEMA "${f.schema}" CASCADE`);
    await f.db.close();
  }
});

for (const step of [11, 12]) {
  Deno.test(`v${step} checkpoint refuses live work, rolls back failure and resumes a lost commit`, async () => {
    const f = await fixture();
    try {
      await assertRejects(() => upgradeActionLifecycle(f.db, f.schema));
      if (step === 12) {
        await assertRejects(() =>
          upgradeActionLifecycle(f.db, f.schema, {
            ownerKeys: f.options.ownerKeys,
          })
        );
      }
      const version = async () =>
        Number(
          (await f.db.query<{ version: number }>(
            `SELECT version FROM ${f.store.tables.copilotz_schema_metadata}`,
          )).rows[0].version,
        );
      assertEquals(await version(), step);
      await f.db.query(
        `INSERT INTO ${f.store.tables.open_actions}(namespace,action_run_id,action_id,scope_id,invoked_event_id,state) VALUES('space','pending','fixture','scope',$1,'invoked')`,
        [f.root.event.id],
      );
      await assertRejects(
        () => upgradeActionLifecycle(f.db, f.schema, f.options),
        Error,
        "Drain existing",
      );
      assertEquals(await version(), step);
      await f.db.query(`DELETE FROM ${f.store.tables.open_actions}`);
      const sqlMarker = step === 11 ? "SET version=12" : "SET version=13";
      const failure = (lost: boolean): SqlSession => ({
        query: f.db.query,
        async transaction(run) {
          let applied = false;
          const result = await f.db.transaction((tx) =>
            run({
              query(sql, params) {
                if (sql.includes(sqlMarker)) {
                  if (!lost) throw new Error("injected step failure");
                  applied = true;
                }
                return tx.query(sql, params);
              },
            })
          );
          if (applied) throw new Error("commit acknowledgement lost");
          return result;
        },
      });
      await assertRejects(
        () => upgradeActionLifecycle(failure(false), f.schema, f.options),
        Error,
        "injected step failure",
      );
      assertEquals(await version(), step);
      await assertRejects(
        () => upgradeActionLifecycle(failure(true), f.schema, f.options),
        Error,
        "commit acknowledgement lost",
      );
      assertEquals(await version(), step + 1);
      await upgradeActionLifecycle(f.db, f.schema, f.options);
      await upgradeActionLifecycle(f.db, f.schema, f.options);
      assertEquals(await version(), 15);
    } finally {
      await f.db.query(`DROP SCHEMA "${f.schema}" CASCADE`);
      await f.db.close();
    }
  });
}

Deno.test("v13 credential upgrade preserves sessions, refuses live work and replays", async () => {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") || ":memory:",
  });
  const schema = `credential_upgrade_${
    crypto.randomUUID().replaceAll("-", "")
  }`;
  const tables = createCoreTableNames(schema);
  try {
    await provisionCopilotzSchema(db, schema);
    await provisionOperationCatalog(db, schema);
    await db.query(`DROP TABLE ${tables.authorization_effects}`);
    await db.query(`UPDATE ${tables.copilotz_schema_metadata} SET version=13`);
    await db.query(
      `INSERT INTO ${tables.authorization_sessions}(namespace,tenant,id,principal,expires_at) VALUES('main','tenant','sid','account','2099-01-01')`,
    );
    const sessions =
      (await db.query(`SELECT * FROM ${tables.authorization_sessions}`)).rows;
    const catalog = createOperationCatalog(db, schema);
    const store = createEventStore({
      session: db,
      schema,
      admitOperationEventSql: (input, param) =>
        catalog.admitEventSql(input, param),
      indexOperationEventSql: (input, param) =>
        catalog.indexEventSql(input, param),
    });
    const event = await store.append({
      namespace: "main",
      type: "pending",
      payload: {},
    }, ["worker"]);
    await assertRejects(() => upgradeActionLifecycle(db, schema));
    assertEquals(
      (await db.query(`SELECT version FROM ${tables.copilotz_schema_metadata}`))
        .rows[0].version,
      13,
    );
    assertEquals(
      (await db.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema=$1 AND table_name='authorization_effects'",
        [schema],
      )).rows.length,
      0,
    );
    // Remove only this synthetic pending operation before exercising the drained path.
    await db.query(`DELETE FROM ${tables.event_deliveries} WHERE event_id=$1`, [
      event.event.id,
    ]);
    await catalog.reconcile();
    await upgradeActionLifecycle(db, schema);
    await upgradeActionLifecycle(db, schema);
    assertEquals((await validateCopilotzSchema(db, schema)).version, 15);
    assertEquals(
      (await db.query(`SELECT * FROM ${tables.authorization_sessions}`)).rows,
      sessions,
    );
  } finally {
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    await db.close();
  }
});

Deno.test("v14 flow admission upgrade preserves consumed identity and backfills exact operation", async () => {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") || ":memory:",
  });
  const schema = `flow_upgrade_${crypto.randomUUID().replaceAll("-", "")}`;
  try {
    await provisionCopilotzSchema(db, schema);
    await provisionOperationCatalog(db, schema);
    await db.query(
      `ALTER TABLE "${schema}".authorization_effects DROP COLUMN accepted_operation`,
    );
    await db.query(
      `UPDATE "${schema}".copilotz_schema_metadata SET version=14`,
    );
    await db.query(
      `INSERT INTO "${schema}".authorization_effects(namespace,tenant,effect_key,run_id,operation_id,initiator,method,intent,claims,consumed_run) VALUES('main','tenant','flow','start-run','start-operation','{}','flow.start','{}','{}','callback-run')`,
    );
    await db.query(
      `INSERT INTO "${schema}".authorization_invocations(namespace,run_id,source_event_id,authority) VALUES('main','callback-run','callback-operation','{}')`,
    );
    await assertRejects(() => validateCopilotzSchema(db, schema));
    await upgradeActionLifecycle(db, schema);
    await upgradeActionLifecycle(db, schema);
    assertEquals((await validateCopilotzSchema(db, schema)).version, 15);
    assertEquals(
      (await db.query(
        `SELECT operation_id,accepted_operation,consumed_run FROM "${schema}".authorization_effects`,
      )).rows,
      [{
        operation_id: "start-operation",
        accepted_operation: "callback-operation",
        consumed_run: "callback-run",
      }],
    );
  } finally {
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    await db.close();
  }
});
