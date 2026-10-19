import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import { restoreRetainedFixture } from "../../scripts/fixtures/retained-upgrade/load.ts";
import {
  createCoreTableNames,
  EVENT_SCHEMA_VERSION,
  provisionCopilotzSchema,
} from "../events/schema.ts";
import { createEventStore } from "../events/store.ts";
import { createOperationCatalog } from "../streams/catalog.ts";
import { createContentCatalog, openLogicalBody } from "../content/catalog.ts";
import { createDatabaseBodyStore } from "../content/database-body-store.ts";
import { encodeEventBody } from "../events/body-store.ts";
import { digestContent } from "../content/digest.ts";
import type { SqlExecutor, SqlSession } from "../events/session.ts";
import { createCopilotz } from "../../create-copilotz.ts";
import { defineAction } from "./define.ts";
import { definePlugin } from "../plugins/index.ts";
import { inspectRetainedDataDrain } from "./drain.ts";
import {
  prepareRetainedDataUpgrade,
  type RetainedDataUpgradePlan,
  upgradeActionLifecycle,
} from "./upgrade.ts";

async function fixture() {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") || ":memory:",
  });
  const schema = `upgrade_${crypto.randomUUID().replaceAll("-", "")}`;
  const original = await restoreRetainedFixture(db, schema);
  return {
    db,
    schema,
    original,
    tables: createCoreTableNames(schema),
    async close() {
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.close();
    },
  };
}
function join(tx: SqlExecutor): SqlSession {
  return { query: tx.query, transaction: (run) => run(tx) };
}
async function finish(
  db: SqlSession,
  schema: string,
  plan: RetainedDataUpgradePlan,
) {
  await upgradeActionLifecycle(db, schema, {
    plan,
    reviewedFingerprint: plan.fingerprint,
  });
}
async function marker(db: SqlExecutor, schema: string) {
  return (await db.query<{ version: number }>(
    `SELECT version FROM "${schema}".copilotz_schema_metadata`,
  )).rows[0].version;
}
async function physical(db: SqlExecutor, schema: string) {
  return (await db.query(
    `SELECT body_id,version_token,reservation_id FROM "${schema}".content_bodies ORDER BY body_id`,
  )).rows;
}

Deno.test("real old-code history upgrades, replays historical cursors and activates the sole owner", async () => {
  const f = await fixture();
  try {
    assertEquals(
      (await inspectRetainedDataDrain(f.db, f.schema)).drained,
      true,
    );
    const history =
      (await f.db.query(`SELECT * FROM ${f.tables.events} ORDER BY position`))
        .rows;
    const indexed = (await f.db.query(
      `SELECT * FROM "${f.schema}".copilotz_operation_events ORDER BY event_position`,
    )).rows;
    const oldStreams = (await f.db.query(
      `SELECT namespace,operation_id,replay_key,stream_id,stream_ordinal,committed_offset FROM "${f.schema}".copilotz_operation_streams ORDER BY replay_key`,
    )).rows;
    assert(
      Number(history.at(-1)!.position) > history.length,
      "fixture has a real old allocation gap",
    );
    const plan = await prepareRetainedDataUpgrade(f.db, f.schema);
    assertExists(plan);
    assertEquals(plan.sourceVersion, 7);
    assertEquals(plan.content.inventory.length, 5);
    assertEquals(plan.ownership.executionOwners, 1);
    assertEquals(await marker(f.db, f.schema), 0);
    const beforePhysical = await physical(f.db, f.schema);
    const resumed = await prepareRetainedDataUpgrade(f.db, f.schema);
    assertEquals(resumed, plan);
    assertEquals(await physical(f.db, f.schema), beforePhysical);
    await assertRejects(
      () => provisionCopilotzSchema(f.db, f.schema),
      Error,
      "incompatible",
    );
    await assertRejects(
      () =>
        createCopilotz({
          database: {
            ...f.db,
            close: () => Promise.resolve(),
          },
          databaseSchema: f.schema,
          namespace: "archive",
        }),
      Error,
      "incompatible",
    );
    const old = Deno.env.get("COPILOTZ_TEST_OLD_CHECKOUT");
    if (old && Deno.env.get("COPILOTZ_TEST_POSTGRES_URL")) {
      const probe = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          "--config",
          `${old}/deno.json`,
          new URL(
            "../../scripts/fixtures/retained-upgrade/probe-old.ts",
            import.meta.url,
          ).pathname,
          old,
          f.schema,
        ],
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(probe.code, 0, new TextDecoder().decode(probe.stderr));
      console.log(new TextDecoder().decode(probe.stdout).trim());
    }
    await finish(f.db, f.schema, plan);
    await finish(f.db, f.schema, plan);
    await upgradeActionLifecycle(f.db, f.schema);
    assertEquals(await marker(f.db, f.schema), EVENT_SCHEMA_VERSION);
    // A shared final version cannot bless a partial lane inventory. Validation
    // must reject each missing family without repairing or replacing its marker.
    for (
      const incomplete of [
        `DROP TABLE ${f.tables.action_effects}`,
        `DROP TABLE ${f.tables.content_copies}`,
        `DROP TABLE ${f.tables.owner_deadlines}`,
        `DROP TABLE ${f.tables.owner_receipts}`,
        `ALTER TABLE ${f.tables.events} DROP COLUMN seq`,
      ]
    ) {
      await assertRejects(
        () =>
          f.db.transaction(async (tx) => {
            await tx.query(incomplete);
            await assertRejects(
              () => provisionCopilotzSchema(join(tx), f.schema),
              Error,
              "not provisioned",
            );
            assertEquals(await marker(tx, f.schema), EVENT_SCHEMA_VERSION);
            throw new Error("rollback incomplete inventory");
          }),
        Error,
        "rollback incomplete inventory",
      );
    }
    const upgraded =
      (await f.db.query(`SELECT * FROM ${f.tables.events} ORDER BY seq`)).rows;
    assertEquals(upgraded.map(({ seq: _seq, ...event }) => event), history);
    assertEquals(
      upgraded.map((event) => Number(event.seq)),
      history.map((_, index) => index + 1),
    );
    assertEquals(
      (await f.db.query(
        `SELECT * FROM "${f.schema}".copilotz_operation_events ORDER BY event_position`,
      )).rows,
      indexed,
    );
    assertEquals(
      (await f.db.query(
        `SELECT s.namespace,operation_id,replay_key,stream_id,stream_ordinal,b.committed_offset
          FROM "${f.schema}".copilotz_operation_streams s
          JOIN ${f.tables.content_logical_bodies} b ON b.body_id=s.body_id
          ORDER BY replay_key`,
      )).rows,
      oldStreams,
    );
    assertEquals(
      (await f.db.query(
        `SELECT * FROM ${f.tables.nodes} WHERE type='@copilotz/action-content'`,
      )).rows,
      [],
    );
    assertEquals(
      (await f.db.query(`SELECT * FROM ${f.tables.owner_receipts}`)).rows,
      [],
    );
    assertEquals(
      (await f.db.query(`SELECT * FROM ${f.tables.owner_alarms}`)).rows,
      [],
    );
    await assertRejects(
      () => f.db.query(`UPDATE ${f.tables.events} SET type='changed'`),
      Error,
      "immutable",
    );
    const catalog = createOperationCatalog(f.db, f.schema);
    for (const stream of oldStreams) {
      const current = await catalog.getStream(
        String(stream.namespace),
        String(stream.operation_id),
        String(stream.stream_id),
      );
      assertExists(current);
      const name = String(stream.stream_id);
      if (name === "stream-superseded") {
        assertEquals(current.outcome, "cancelled");
        assertEquals(current.reason, "superseded");
      }
      if (name === "stream-abandoned") {
        assertEquals(current.outcome, "failed");
        assertEquals(current.reason, "abandoned");
      }
      if (name === "stream-missing") {
        assertEquals(current.availability, "purged");
        assertEquals(current.availabilityReason, "missing");
      }
      if (name === "stream-purge_pending") {
        assertEquals(current.availability, "retained");
        assertEquals(current.cleanupState, "pending");
      }
      const events = indexed.filter((event) =>
        event.operation_id === stream.operation_id
      );
      const cursor = String(events[0].event_position);
      assertEquals(
        await catalog.listEventIds({
          namespace: String(stream.namespace),
          operationId: String(stream.operation_id),
          afterPosition: cursor,
        }),
        events.slice(1).map((event) => ({
          eventId: String(event.event_id),
          position: String(event.event_position),
        })),
      );
    }
    const asset =
      (await f.db.query<{ data: { bodyId: string; location?: unknown } }>(
        `SELECT data FROM ${f.tables.nodes} WHERE type='asset'`,
      )).rows[0].data;
    assertEquals(asset.location, undefined);
    assertEquals(
      await new Response(
        await openLogicalBody(
          createContentCatalog(f.db, f.schema),
          asset.bodyId,
          () =>
            createDatabaseBodyStore({
              session: f.db,
              schema: f.schema,
              provisioned: true,
            }),
        ),
      ).text(),
      "retained original content",
    );
    const captured = (await f.db.query<{ body: { input: unknown } }>(
      `SELECT body FROM ${f.tables.event_bodies} WHERE body->>'actionId'='upgrade.capture' AND body->>'status'='invoked'`,
    )).rows[0].body;
    assertEquals(captured.input, { value: "original captured input" });
    let executed = 0;
    const app = await createCopilotz({
      database: { ...f.db, close: () => Promise.resolve() },
      databaseSchema: f.schema,
      namespace: "archive",
      plugins: [definePlugin({
        id: "upgrade.fixture",
        version: "1",
        actions: {
          prepareParent: defineAction({
            id: "upgrade.prepare-parent",
            execute() {
              executed++;
              throw new Error("Retained preparation must not re-execute.");
            },
          }),
          fresh: defineAction({
            id: "upgrade.fresh",
            execute: (input: unknown) => input,
          }),
        },
      })],
    });
    try {
      assertEquals(
        await app.actions.prepareParent({}, {
          idempotencyKey: "retained-preparation",
        }),
        { value: "original captured input" },
      );
      assertEquals(executed, 0);
      assertEquals(
        await app.actions.fresh({ ready: true }, {
          idempotencyKey: "new-owner-request",
        }),
        { ready: true },
      );
      const store = createEventStore({ session: f.db, schema: f.schema });
      const first = await store.getEvent(String(history[0].id));
      assertExists(first);
      assertEquals(first.seq, "1");
    } finally {
      await app.close();
    }
    const sequences = (await f.db.query<{ seq: string }>(
      `SELECT seq FROM ${f.tables.events} ORDER BY seq`,
    )).rows.map((row) => Number(row.seq));
    assertEquals(sequences, sequences.map((_, index) => index + 1));
    assert(sequences.length > history.length);
  } finally {
    await f.close();
  }
});

Deno.test("real old-code drain refuses every live family without changing its version", async () => {
  const f = await fixture();
  try {
    const eventId = String(f.original.rows.events[0].id);
    const scenarios = [
      `UPDATE ${f.tables.event_deliveries} SET status='pending'`,
      `INSERT INTO ${f.tables.open_actions}(namespace,action_run_id,action_id,scope_id,invoked_event_id,state) VALUES('archive','undrained','test','scope','${eventId}','deferred')`,
      `INSERT INTO ${f.tables.open_actions}(namespace,action_run_id,action_id,scope_id,invoked_event_id,state) VALUES('archive','undrained','test','scope','${eventId}','resolving')`,
      `UPDATE "${f.schema}".copilotz_operations SET state='running',cancellation_requested_at=NOW()`,
      `UPDATE "${f.schema}".copilotz_operation_streams SET state='terminating',terminal_at=NULL WHERE stream_id='stream-completed'`,
      `CREATE TABLE "${f.schema}".action_effects(status TEXT); INSERT INTO "${f.schema}".action_effects VALUES('begun')`,
    ];
    for (const sql of scenarios) {
      await assertRejects(
        () =>
          f.db.transaction(async (tx) => {
            for (const statement of sql.split("; ")) await tx.query(statement);
            await assertRejects(
              () => prepareRetainedDataUpgrade(join(tx), f.schema),
              Error,
              "Drain existing",
            );
            assertEquals(await marker(tx, f.schema), 7);
            throw new Error("rollback test mutation");
          }),
        Error,
        "rollback test mutation",
      );
    }
  } finally {
    await f.close();
  }
});

Deno.test("upgrade rejects corrupted original captures, orphan invocations and missing retained bytes", async () => {
  const f = await fixture();
  try {
    for (
      const failure of [
        "digest",
        "invocation",
        "bytes",
        "namespace",
        "reference",
      ]
    ) {
      await assertRejects(
        () =>
          f.db.transaction(async (tx) => {
            if (failure === "digest") {
              await tx.query(
                `UPDATE ${f.tables.event_bodies} SET digest='sha256:bad' WHERE body->>'actionId'='upgrade.capture'`,
              );
            }
            if (failure === "invocation") {
              const body = await encodeEventBody({
                status: "invoked",
                actionRunId: "lost-obligation",
                actionId: "external-call",
                input: { original: true },
              });
              await tx.query(
                `INSERT INTO ${f.tables.event_bodies}(namespace,event_body_id,schema_version,body,digest) VALUES('archive','orphan-invocation',1,$1::jsonb,$2)`,
                [body.body, body.digest],
              );
            }
            if (failure === "bytes") {
              await tx.query(
                `DELETE FROM "${f.schema}".content_body_parts WHERE body_id='retained-completed'`,
              );
            }
            if (failure === "namespace") {
              await tx.query(
                `UPDATE ${f.tables.edges} SET namespace='another-namespace'`,
              );
            }
            if (failure === "reference") {
              await tx.query(
                `UPDATE "${f.schema}".copilotz_operation_events SET event_id='missing-reference' WHERE event_id=(SELECT event_id FROM "${f.schema}".copilotz_operation_events LIMIT 1)`,
              );
            }
            await assertRejects(() =>
              prepareRetainedDataUpgrade(join(tx), f.schema)
            );
            assertEquals(await marker(tx, f.schema), 7);
            throw new Error("rollback test mutation");
          }),
        Error,
        "rollback test mutation",
      );
    }
  } finally {
    await f.close();
  }
});

Deno.test("prepared upgrade survives failed inventory and finalization, rejects mixed plans and resumes once", async () => {
  const f = await fixture();
  try {
    await assertRejects(
      () =>
        prepareRetainedDataUpgrade(f.db, f.schema, {
          storeFor() {
            throw new Error("offline backend unavailable");
          },
        }),
      Error,
      "offline backend unavailable",
    );
    assertEquals(await marker(f.db, f.schema), 0);
    const before = await physical(f.db, f.schema);
    const plan = await prepareRetainedDataUpgrade(f.db, f.schema);
    assertExists(plan);
    assertEquals(await physical(f.db, f.schema), before);
    await assertRejects(
      () =>
        upgradeActionLifecycle(f.db, f.schema, {
          plan,
          reviewedFingerprint: "different",
        }),
      Error,
      "fingerprint",
    );
    await assertRejects(
      () => finish(f.db, f.schema, { ...plan, id: "other-source" }),
      Error,
      "mixed",
    );
    await assertRejects(
      () =>
        finish(f.db, f.schema, {
          ...plan,
          content: { ...plan.content, inventory: [] },
        }),
      Error,
      "mixed",
    );
    for (
      const mutation of [
        "upgrade_id='different-preparation'",
        "upgrade_from=5",
        "upgrade_to=11",
      ]
    ) {
      await assertRejects(
        () =>
          f.db.transaction(async (tx) => {
            await tx.query(
              `UPDATE ${f.tables.copilotz_schema_metadata} SET ${mutation}`,
            );
            await assertRejects(
              () => finish(join(tx), f.schema, plan),
              Error,
              "identity",
            );
            assertEquals(await marker(tx, f.schema), 0);
            throw new Error("rollback marker mutation");
          }),
        Error,
        "rollback marker mutation",
      );
    }
    for (
      const mutation of ["upgrade_id=NULL", "upgrade_to=11", "upgrade_from=0"]
    ) {
      await assertRejects(
        () =>
          f.db.transaction(async (tx) => {
            await tx.query(
              `UPDATE ${f.tables.copilotz_schema_metadata} SET ${mutation}`,
            );
            await assertRejects(
              () => upgradeActionLifecycle(join(tx), f.schema),
              Error,
              "Interrupted upgrade marker",
            );
            assertEquals(await marker(tx, f.schema), 0);
            throw new Error("rollback marker mutation");
          }),
        Error,
        "rollback marker mutation",
      );
    }
    const failing: SqlSession = {
      query: f.db.query,
      transaction: (run) =>
        f.db.transaction((tx) =>
          run({
            query(sql, params) {
              if (sql.includes("SET version = $1")) {
                throw new Error("injected final marker failure");
              }
              return tx.query(sql, params);
            },
          })
        ),
    };
    await assertRejects(
      () => finish(failing, f.schema, plan),
      Error,
      "injected final marker failure",
    );
    assertEquals(await marker(f.db, f.schema), 0);
    assertEquals(await physical(f.db, f.schema), before);
    assertEquals(
      (await f.db.query(
        `SELECT * FROM ${f.tables.nodes} WHERE type='@copilotz/action-content'`,
      )).rows.length,
      1,
    );
    await finish(f.db, f.schema, plan);
    await finish(f.db, f.schema, plan);
  } finally {
    await f.close();
  }
});

Deno.test("lost prepare and final commit acknowledgements recover from durable upgrade identity", async () => {
  const f = await fixture();
  try {
    const loseAcknowledgement = (): SqlSession => ({
      query: f.db.query,
      async transaction(run) {
        const result = await f.db.transaction(run);
        void result;
        throw new Error("commit acknowledgement lost");
      },
    });
    await assertRejects(
      () => prepareRetainedDataUpgrade(loseAcknowledgement(), f.schema),
      Error,
      "commit acknowledgement lost",
    );
    assertEquals(await marker(f.db, f.schema), 0);
    const before = await physical(f.db, f.schema);
    const plan = await prepareRetainedDataUpgrade(f.db, f.schema);
    assertExists(plan);
    assertEquals(await physical(f.db, f.schema), before);
    const asset = plan.ownership.assets[0];
    assertExists(asset.producers[0]);
    const decisions = [{
      namespace: asset.namespace,
      assetId: asset.assetId,
      ownerId: asset.producers[0].id,
    }];
    const apply = (session: SqlSession) =>
      upgradeActionLifecycle(session, f.schema, {
        plan,
        reviewedFingerprint: plan.fingerprint,
        contentDecisions: decisions,
      });
    await assertRejects(
      () => apply(loseAcknowledgement()),
      Error,
      "commit acknowledgement lost",
    );
    assertEquals(await marker(f.db, f.schema), EVENT_SCHEMA_VERSION);
    const history =
      (await f.db.query(`SELECT * FROM ${f.tables.events} ORDER BY position`))
        .rows;
    const accepted = (await f.db.query(
      `SELECT upgrade_reviewed_fingerprint,upgrade_decisions_fingerprint FROM ${f.tables.copilotz_schema_metadata}`,
    )).rows[0];
    assertEquals(accepted.upgrade_reviewed_fingerprint, plan.fingerprint);
    assertEquals(
      accepted.upgrade_decisions_fingerprint,
      await digestContent(new TextEncoder().encode(JSON.stringify(decisions))),
    );
    await apply(f.db);
    // Canonical decision property order does not change the accepted intent.
    await upgradeActionLifecycle(f.db, f.schema, {
      plan,
      reviewedFingerprint: plan.fingerprint,
      contentDecisions: [{
        ownerId: decisions[0].ownerId,
        assetId: asset.assetId,
        namespace: asset.namespace,
      }],
    });
    for (const changed of [[], [{ ...decisions[0], ownerId: null }]]) {
      await assertRejects(
        () =>
          upgradeActionLifecycle(f.db, f.schema, {
            plan,
            reviewedFingerprint: plan.fingerprint,
            contentDecisions: changed,
          }),
        Error,
        "accepted plan or ownership decisions",
      );
    }
    const changedPlan = {
      ...plan,
      ownership: {
        ...plan.ownership,
        assignedOwners: plan.ownership.assignedOwners + 1,
      },
    };
    changedPlan.fingerprint = await digestContent(
      new TextEncoder().encode(JSON.stringify({
        schema: changedPlan.schema,
        id: changedPlan.id,
        sourceVersion: changedPlan.sourceVersion,
        targetVersion: changedPlan.targetVersion,
        content: changedPlan.content,
        ownership: changedPlan.ownership,
      })),
    );
    await assertRejects(
      () =>
        upgradeActionLifecycle(f.db, f.schema, {
          plan: changedPlan,
          reviewedFingerprint: changedPlan.fingerprint,
          contentDecisions: decisions,
        }),
      Error,
      "accepted plan or ownership decisions",
    );
    await assertRejects(
      () =>
        upgradeActionLifecycle(f.db, f.schema, { contentDecisions: decisions }),
      Error,
      "original retained-data plan",
    );
    await apply(f.db);
    assertEquals(
      (await f.db.query(
        `SELECT upgrade_reviewed_fingerprint,upgrade_decisions_fingerprint FROM ${f.tables.copilotz_schema_metadata}`,
      )).rows[0],
      accepted,
    );
    assertEquals(
      (await f.db.query(`SELECT * FROM ${f.tables.events} ORDER BY position`))
        .rows,
      history,
    );
  } finally {
    await f.close();
  }
});

Deno.test("changed prepared physical version cannot become ready under an earlier review", async () => {
  const f = await fixture();
  try {
    const plan = await prepareRetainedDataUpgrade(f.db, f.schema);
    assertExists(plan);
    const old = await physical(f.db, f.schema);
    await f.db.query(
      `UPDATE "${f.schema}".content_bodies SET version_token='changed-after-review' WHERE body_id='retained-completed'`,
    );
    await assertRejects(
      () => finish(f.db, f.schema, plan),
      Error,
      "changed after review",
    );
    assertEquals(await marker(f.db, f.schema), 0);
    const body = old.find((row) => row.body_id === "retained-completed")!;
    await f.db.query(
      `UPDATE "${f.schema}".content_bodies SET version_token=$1 WHERE body_id='retained-completed'`,
      [body.version_token],
    );
    await assertRejects(
      () =>
        f.db.transaction(async (tx) => {
          await tx.query(
            `UPDATE "${f.schema}".content_body_parts SET bytes=set_byte(bytes,0,(get_byte(bytes,0)+1)%256) WHERE body_id='retained-completed'`,
          );
          await assertRejects(() => finish(join(tx), f.schema, plan));
          assertEquals(await marker(tx, f.schema), 0);
          throw new Error("rollback changed bytes");
        }),
      Error,
      "rollback changed bytes",
    );
    await finish(f.db, f.schema, plan);
  } finally {
    await f.close();
  }
});
