import { bindTestActions, testAuthority } from "../testing/authority.ts";
import { testAuthorityManifest } from "../testing/upgrade.ts";
import { testSecretAdapter } from "../testing/secret-adapter.ts";
import { UpgradeStepRequiredError } from "./upgrade-errors.ts";
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
  upgradeActionLifecycle as upgradeChain,
} from "./upgrade.ts";

const inputs = new Map<string, Parameters<typeof upgradeChain>[2]>();
async function upgradeActionLifecycle(
  db: SqlSession,
  schema: string,
  options: Parameters<typeof upgradeChain>[2] = {},
) {
  let supplied = inputs.get(schema);
  if (!supplied) {
    const adapter = await testSecretAdapter();
    supplied = {
      ownerKeys: { sourceAdapter: adapter, masterAdapter: adapter },
    };
    inputs.set(schema, supplied);
  }
  try {
    await upgradeChain(db, schema, { ...supplied, ...options });
  } catch (error) {
    if (
      !(error instanceof UpgradeStepRequiredError) ||
      error.code !== "copilotz_upgrade_authority_required"
    ) throw error;
    supplied = {
      ...supplied,
      authority: await testAuthorityManifest(db, schema),
    };
    inputs.set(schema, supplied);
    await upgradeChain(db, schema, { ...supplied, ...options });
  }
}

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
    assertEquals(
      upgraded.map(({ seq: _seq, owner_ingress: _ingress, ...event }) => event),
      history,
    );
    const manifest = inputs.get(f.schema)!.authority!;
    for (const event of upgraded) {
      const binding = (manifest.events ?? []).find((entry) =>
        entry.eventId === event.id
      );
      assertEquals(
        event.owner_ingress,
        binding ? { kind: "host", authority: binding.authority } : null,
      );
    }
    assertEquals(
      Number(
        (await f.db.query<{ count: number }>(
          `SELECT COUNT(*)::integer AS count FROM ${f.tables.authorization_invocations}`,
        )).rows[0].count,
      ),
      (manifest.invocations ?? []).length,
    );
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
      (await f.db.query(
        `SELECT * FROM ${f.tables.owner_receipts} WHERE kind NOT IN ('owner-keys.upgrade','authorization.upgrade','authorization.history','action.protected-input')`,
      )).rows,
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
      authorization: {
        policies: {
          fixture: {
            revision: "1",
            sources: [],
            evaluate: () => ({ actions: { prepareParent: {}, fresh: {} } }),
          },
        },
        actions: {
          prepareParent: { id: "fixture", revision: "1" },
          fresh: { id: "fixture", revision: "1" },
        },
        collections: {},
      },
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
    const actions = bindTestActions(
      app.actions,
      testAuthority(f.schema, "archive"),
    );
    try {
      await assertRejects(() =>
        actions.prepareParent({}, {
          idempotencyKey: "retained-preparation",
        })
      );
      assertEquals(executed, 0);
      assertEquals(
        await actions.fresh({ ready: true }, {
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
        `upgrade_to=${EVENT_SCHEMA_VERSION + 1}`,
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
      const mutation of [
        "upgrade_id=NULL",
        `upgrade_to=${EVENT_SCHEMA_VERSION + 1}`,
        "upgrade_from=0",
      ]
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
    assertEquals(await marker(f.db, f.schema), 11);
    const retainedHistory =
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
    const history =
      (await f.db.query(`SELECT * FROM ${f.tables.events} ORDER BY position`))
        .rows;
    assertEquals(
      history.map(({ owner_ingress: _ingress, ...event }) => event),
      retainedHistory.map(({ owner_ingress: _ingress, ...event }) => event),
    );
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

Deno.test("external content prepares and finalizes with a read-only store and deterministic bounded concurrency", async () => {
  const f = await fixture();
  try {
    const { createMemoryBodyStore } = await import("../content/body-store.ts");
    const memory = createMemoryBodyStore({ backendId: "synthetic:external" });
    const bytes = new TextEncoder().encode("synthetic external content");
    const digest = await digestContent(bytes);
    for (let i = 0; i < 32; i++) {
      await memory.put({
        bodyId: `external-${i}`,
        bytes,
        digest,
        mediaType: "text/plain",
      });
      await f.db.query(
        `INSERT INTO ${f.tables.nodes}(id,namespace,type,name,data) VALUES($1,'archive','asset',$1,$2::jsonb)`,
        [
          `external-${i}`,
          JSON.stringify({
            location: {
              kind: "object",
              backendId: memory.backendId,
              key: `external-${i}`,
            },
            byteLength: bytes.length,
            digest,
          }),
        ],
      );
    }
    let active = 0, peak = 0, heads = 0, ranges = 0;
    const pause = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
    };
    const forbidden = () => {
      throw new Error("external mutation forbidden");
    };
    const store = {
      ...memory,
      kind: "object" as const,
      async head(input: Parameters<typeof memory.head>[0]) {
        heads++;
        await pause();
        return await memory.head(input);
      },
      async readRange(input: Parameters<typeof memory.readRange>[0]) {
        ranges++;
        await pause();
        return await memory.readRange(input);
      },
      put: forbidden,
      reserve: forbidden,
      fence: forbidden,
      append: forbidden,
      seal: forbidden,
      terminate: forbidden,
      abort: forbidden,
      maintenance: { list: forbidden, delete: forbidden },
    };
    const storage = {
      storeFor: (location: { kind: string; backendId: string }) =>
        location.kind === "object" && location.backendId === store.backendId
          ? store
          : undefined,
    };
    const sequential = await prepareRetainedDataUpgrade(f.db, f.schema, {
      ...storage,
      concurrency: 1,
    });
    assert(sequential);
    assertEquals(peak, 1);
    peak = 0;
    const parallel = await prepareRetainedDataUpgrade(f.db, f.schema, {
      ...storage,
      concurrency: 16,
    });
    assertEquals(parallel, sequential);
    assert(peak > 1 && peak <= 16);
    await upgradeActionLifecycle(f.db, f.schema, {
      ...storage,
      plan: parallel,
      reviewedFingerprint: parallel!.fingerprint,
    });
    assertEquals(await marker(f.db, f.schema), 14);
    assertEquals(heads, 128);
    assertEquals(ranges, 128);
  } finally {
    await f.close();
  }
});

Deno.test("wrapper attestations and reviewed referenced abandonment survive v7 through v14", async () => {
  const { abandonmentDecisions } = await import("./upgrade-terminals.ts");
  const { createActionLifecycleLoader } = await import("./persistence.ts");
  const { pruneRetainedHistory } = await import(
    "../../scripts/prune-retained-history.ts"
  );
  const f = await fixture();
  try {
    const add = async (id: string, body: Record<string, unknown>) => {
      const encoded = await encodeEventBody(body);
      await f.db.query(
        `INSERT INTO ${f.tables.event_bodies}(namespace,event_body_id,schema_version,body,digest) VALUES('archive',$1,1,$2::jsonb,$3)`,
        [id, encoded.body, encoded.digest],
      );
    };
    for (const status of ["completed", "failed"] as const) {
      await add(`target-${status}`, {
        actionId: "synthetic.target",
        actionRunId: status,
        status: "invoked",
        input: {},
        metadata: {},
      });
      await add(`wrapper-${status}`, {
        actionId: "copilotz.server.internal.invoke",
        actionRunId: `wrapper-${status}`,
        status: "completed",
        output: { status, targetActionRunId: status },
      });
    }
    await add("orphan-body", {
      actionId: "synthetic.target",
      actionRunId: "orphan",
      status: "invoked",
      input: {},
      metadata: {},
    });
    const event = {
      ...f.original.rows.events[0],
      id: "orphan-event",
      position: 10000,
      type: "synthetic.target.invoked",
      subject_type: "synthetic.target",
      subject_id: "orphan",
      deduplication_id: "orphan:action:invoked",
      payload: {
        dataRef: {
          eventBodyId: "orphan-body",
          schemaVersion: 1,
          mediaType: "application/json",
        },
      },
      metadata: {
        actionId: "synthetic.target",
        actionStatus: "invoked",
        sourceEventId: f.original.rows.events[0].id,
      },
    };
    await f.db.query(
      `INSERT INTO ${f.tables.events} SELECT * FROM jsonb_populate_record(NULL::${f.tables.events},$1::jsonb)`,
      [JSON.stringify(event)],
    );
    const indexed = {
      ...f.original.rows.copilotz_operation_events[0],
      event_id: event.id,
      event_position: 10000,
      event_ordinal: 10000,
    };
    await f.db.query(
      `INSERT INTO "${f.schema}".copilotz_operation_events SELECT * FROM jsonb_populate_record(NULL::"${f.schema}".copilotz_operation_events,$1::jsonb)`,
      [JSON.stringify(indexed)],
    );
    await assertRejects(
      () => prepareRetainedDataUpgrade(f.db, f.schema),
      Error,
      "no confirmed terminal",
    );
    const abandoned = await abandonmentDecisions([{
      namespace: "archive",
      runId: "orphan",
      actionId: "synthetic.target",
      bodyId: "orphan-body",
    }]);
    const listing = (await pruneRetainedHistory(f.db, {
      schema: f.schema,
      eventTypes: [],
      listUnterminated: true,
      progress: () => {},
    })).unterminated!;
    assertEquals(
      listing.invocations.find((i) => i.runId === "completed")?.terminal,
      "attested",
    );
    assertEquals(
      listing.invocations.find((i) => i.runId === "orphan")?.terminal,
      "unattested",
    );
    assertEquals(
      listing.invocations.find((i) => i.runId === "orphan")?.retainedReference,
      true,
    );
    const plan = await prepareRetainedDataUpgrade(f.db, f.schema, {
      abandoned,
    });
    assertExists(plan);
    assertEquals(plan.terminals?.abandoned, 1);
    assertEquals(plan.terminals?.attested, 2);
    await assertRejects(
      () =>
        upgradeChain(f.db, f.schema, {
          plan,
          reviewedFingerprint: plan.fingerprint,
        }),
      Error,
      "no confirmed terminal",
    );
    await upgradeActionLifecycle(f.db, f.schema, {
      plan,
      reviewedFingerprint: plan.fingerprint,
      abandoned,
    });
    assertEquals(await marker(f.db, f.schema), 14);
    await upgradeActionLifecycle(f.db, f.schema, {
      plan,
      reviewedFingerprint: plan.fingerprint,
      abandoned,
    });
    await assertRejects(
      () =>
        upgradeChain(f.db, f.schema, {
          plan,
          reviewedFingerprint: plan.fingerprint,
        }),
      Error,
      "Completed upgrade replay differs",
    );
    const receipts = (await f.db.query<{ result: Record<string, unknown> }>(
      `SELECT result FROM ${f.tables.owner_receipts} WHERE kind='action.upgrade-terminal' ORDER BY key`,
    )).rows;
    assertEquals(receipts.length, 3);
    for (const { result } of receipts) {
      assertEquals("output" in result, false);
      assertEquals("digest" in result, false);
    }
    const { actionOwnershipStatement } = await import("./ownership.ts");
    for (const runId of ["completed", "failed", "orphan", "fresh"]) {
      const params: unknown[] = [];
      const statement = actionOwnershipStatement(
        {
          draft: { namespace: "archive", type: "synthetic.target.invoked" },
          data: {
            actionRunId: runId,
            actionId: "synthetic.target",
            status: "invoked",
            input: {},
            metadata: {},
          },
        },
        undefined,
        f.tables,
        (value) => {
          params.push(value);
          return `$${params.length}`;
        },
        new Date().toISOString(),
      );
      const allowed = (await f.db.query<{ allowed: boolean }>(
        `SELECT (${statement.gate}) AS allowed`,
        params,
      )).rows[0].allowed;
      assertEquals(
        allowed,
        runId === "fresh",
        "terminal upgrade receipts bar even body-only invocation claims",
      );
    }
    const load = createActionLifecycleLoader({
      store: createEventStore({ session: f.db, schema: f.schema }),
    });
    assertEquals(
      (await load("archive", "completed:action:terminal"))?.status,
      "completed",
    );
    assertEquals(
      (await load("archive", "failed:action:terminal"))?.status,
      "failed",
    );
    const cancelled = await load("archive", "orphan:action:terminal");
    assertEquals(cancelled?.status, "cancelled");
    assert(cancelled?.status === "cancelled");
    assertEquals(cancelled.error.message, "abandoned-before-upgrade");
    assertEquals(
      (await f.db.query(`SELECT * FROM ${f.tables.open_actions}`)).rows,
      [],
    );
  } finally {
    await f.close();
  }
});

Deno.test("reviewed terminal exceptions refuse ambiguity, conflicts, changed decisions and live work", async () => {
  const { abandonmentDecisions } = await import("./upgrade-terminals.ts");
  const f = await fixture();
  try {
    for (
      const scenario of [
        "ambiguous",
        "nonterminal",
        "mismatch",
        "terminal",
        "multiple",
        "open",
        "delivery",
        "digest",
        "body-change",
      ] as const
    ) {
      await assertRejects(
        () =>
          f.db.transaction(async (tx) => {
            const add = async (id: string, body: Record<string, unknown>) => {
              const encoded = await encodeEventBody(body);
              await tx.query(
                `INSERT INTO ${f.tables.event_bodies}(namespace,event_body_id,schema_version,body,digest) VALUES('archive',$1,1,$2::jsonb,$3)`,
                [id, encoded.body, encoded.digest],
              );
            };
            const invocation = {
              actionId: "synthetic.target",
              actionRunId: "target",
              status: "invoked",
            };
            await add("target-body", invocation);
            const abandoned = await abandonmentDecisions([{
              namespace: "archive",
              runId: "target",
              actionId: "synthetic.target",
              bodyId: "target-body",
            }]);
            if (["ambiguous", "nonterminal", "mismatch"].includes(scenario)) {
              await add("wrapper", {
                actionId: "copilotz.server.internal.invoke",
                actionRunId: "wrapper",
                status: "completed",
                output: {
                  targetActionRunId: "target",
                  status: scenario === "nonterminal" ? "running" : "completed",
                  ...(scenario === "mismatch"
                    ? { targetActionId: "wrong" }
                    : {}),
                },
              });
              if (scenario === "ambiguous") {
                await add("wrapper2", {
                  actionId: "copilotz.server.internal.invoke",
                  actionRunId: "wrapper2",
                  status: "completed",
                  output: { targetActionRunId: "target", status: "completed" },
                });
              }
            }
            if (scenario === "terminal") {
              await add("terminal", { ...invocation, status: "completed" });
            }
            if (scenario === "multiple") {
              await add("extra", { ...invocation, status: "progress" });
            }
            if (scenario === "open") {
              await tx.query(
                `INSERT INTO ${f.tables.open_actions}(namespace,action_run_id,action_id,scope_id,invoked_event_id,state) VALUES('archive','target','synthetic.target','scope',$1,'deferred')`,
                [f.original.rows.events[0].id],
              );
            }
            if (scenario === "delivery") {
              await tx.query(
                `UPDATE ${f.tables.event_deliveries} SET status='pending'`,
              );
            }
            if (scenario === "body-change") {
              const plan = await prepareRetainedDataUpgrade(
                join(tx),
                f.schema,
                { abandoned },
              );
              assertExists(plan);
              const encoded = await encodeEventBody({
                ...invocation,
                input: { changed: true },
              });
              await tx.query(
                `UPDATE ${f.tables.event_bodies} SET body=$1::jsonb,digest=$2 WHERE event_body_id='target-body'`,
                [encoded.body, encoded.digest],
              );
              await assertRejects(
                () =>
                  upgradeChain(join(tx), f.schema, {
                    plan,
                    reviewedFingerprint: plan.fingerprint,
                    abandoned,
                  }),
                Error,
                "changed after review",
              );
            } else {
              await assertRejects(() =>
                prepareRetainedDataUpgrade(join(tx), f.schema, {
                  abandoned: scenario === "digest"
                    ? { ...abandoned, digest: "bad" }
                    : abandoned,
                }), Error);
            }
            throw new Error("rollback refusal");
          }),
        Error,
        "rollback refusal",
      );
    }
  } finally {
    await f.close();
  }
});

Deno.test("attestation-only v7 history reaches v14 without decisions", async () => {
  const f = await fixture();
  try {
    for (const status of ["completed", "failed"] as const) {
      for (
        const [id, body] of [
          [`target-${status}`, {
            actionId: "synthetic.target",
            actionRunId: status,
            status: "invoked",
            input: {},
            metadata: {},
          }],
          [`wrapper-${status}`, {
            actionId: "copilotz.server.internal.invoke",
            actionRunId: `wrapper-${status}`,
            status: "completed",
            output: { status, targetActionRunId: status },
          }],
        ] as const
      ) {
        const encoded = await encodeEventBody(body);
        await f.db.query(
          `INSERT INTO ${f.tables.event_bodies}(namespace,event_body_id,schema_version,body,digest) VALUES('archive',$1,1,$2::jsonb,$3)`,
          [id, encoded.body, encoded.digest],
        );
      }
    }
    const plan = await prepareRetainedDataUpgrade(f.db, f.schema);
    assertExists(plan);
    assertEquals(plan.terminals?.attested, 2);
    assertEquals(plan.terminals?.runs.map((r) => r.wrapperBodyId), [
      "wrapper-completed",
      "wrapper-failed",
    ]);
    await assertRejects(
      () =>
        upgradeChain(f.db, f.schema, {
          plan,
          reviewedFingerprint: plan.fingerprint,
        }),
      Error,
      "owner",
    );
    assertEquals(await marker(f.db, f.schema), 11);
    const adapter = await testSecretAdapter();
    await assertRejects(
      () =>
        upgradeChain(f.db, f.schema, {
          ownerKeys: { sourceAdapter: adapter, masterAdapter: adapter },
        }),
      Error,
      "authority",
    );
    assertEquals(await marker(f.db, f.schema), 12);
    await upgradeChain(f.db, f.schema, {
      authority: await testAuthorityManifest(f.db, f.schema),
    });
    assertEquals(await marker(f.db, f.schema), 14);
  } finally {
    await f.close();
  }
});

Deno.test("reviewed missing non-completed streams become unavailable through v14", async () => {
  const { unrecoverableDecisions } = await import(
    "../content/unrecoverable.ts"
  );
  const { listMissingContent } = await import("../content/migration.ts");
  const { retainedContentInspector } = await import("./upgrade.ts");
  const { createMemoryBodyStore } = await import("../content/body-store.ts");
  const f = await fixture();
  try {
    const memory = createMemoryBodyStore({ backendId: "synthetic:missing" });
    const streams = `"${f.schema}".copilotz_operation_streams`;
    const old = (await f.db.query<
      { stream_id: string; outcome: string; namespace: string }
    >(
      `SELECT namespace,stream_id,outcome FROM ${streams} WHERE state='terminal' AND outcome='failed' LIMIT 1`,
    )).rows[0];
    assertExists(old);
    // A cancelled lane must keep its own outcome when its bytes are missing.
    await f.db.query(
      `UPDATE ${streams} SET outcome='cancelled' WHERE namespace=$1 AND stream_id=$2`,
      [old.namespace, old.stream_id],
    );
    // Seed a genuinely external synthetic store; its reader never queries the
    // outer database while v12 holds the transaction connection.
    const physical = (await f.db.query<
      { body_id: string; media_type: string; bytes: Uint8Array }
    >(
      `SELECT b.body_id,b.media_type,p.bytes FROM "${f.schema}".content_bodies b JOIN "${f.schema}".content_body_parts p USING(body_id) ORDER BY b.body_id,p.start_offset`,
    )).rows;
    const grouped = new Map<
      string,
      { mediaType: string; parts: Uint8Array[] }
    >();
    for (const row of physical) {
      const group = grouped.get(row.body_id) ??
        { mediaType: row.media_type, parts: [] };
      group.parts.push(row.bytes);
      grouped.set(row.body_id, group);
    }
    for (const [bodyId, group] of grouped) {
      const bytes = new Uint8Array(
        group.parts.reduce((n, p) => n + p.length, 0),
      );
      let offset = 0;
      for (const part of group.parts) {
        bytes.set(part, offset);
        offset += part.length;
      }
      await memory.put({
        bodyId,
        bytes,
        mediaType: group.mediaType,
        digest: await digestContent(bytes),
      });
    }
    const storage = {
      streamBackend: { kind: "object", backendId: memory.backendId },
      storeFor: (loc: { kind: string }) =>
        loc.kind === "object" ? memory : undefined,
    };
    await f.db.query(
      `UPDATE ${streams} SET body_id='synthetic-missing',availability='retained',committed_offset=10 WHERE stream_id=$1`,
      [old.stream_id],
    );
    const entries = [{
      namespace: old.namespace,
      backendId: memory.backendId,
      key: "synthetic-missing",
    }];
    const unrecoverable = await unrecoverableDecisions(entries);
    await assertRejects(
      () => prepareRetainedDataUpgrade(f.db, f.schema, storage),
      Error,
      "retained terminal copy",
    );
    const listing = await listMissingContent(
      retainedContentInspector(f.db, f.schema, storage),
    );
    assertEquals(
      listing.find((v) => v.key === "synthetic-missing")?.eligible,
      true,
    );
    await assertRejects(
      () =>
        prepareRetainedDataUpgrade(f.db, f.schema, {
          ...storage,
          unrecoverable: { ...unrecoverable, digest: "changed" },
        }),
      Error,
      "digest",
    );
    const plan = await prepareRetainedDataUpgrade(f.db, f.schema, {
      ...storage,
      unrecoverable,
    });
    assertExists(plan);
    await upgradeActionLifecycle(f.db, f.schema, {
      ...storage,
      unrecoverable,
      plan,
      reviewedFingerprint: plan.fingerprint,
    });
    assertEquals(await marker(f.db, f.schema), 14);
    const record = (await f.db.query<
      {
        outcome: string;
        availability: string;
        availability_reason: string;
      }
    >(
      `SELECT outcome,availability,availability_reason FROM ${streams} WHERE stream_id=$1`,
      [old.stream_id],
    )).rows[0];
    assertEquals(record.outcome, "cancelled");
    assertEquals(record.availability, "purged");
    assertEquals(record.availability_reason, "missing");
    const copy = plan.content.inventory.find((v) => v.unavailable)!;
    const tombstone =
      (await f.db.query<{ revocation: string; terminal: unknown }>(
        `SELECT revocation,terminal FROM ${f.tables.content_logical_bodies} WHERE body_id=$1`,
        [copy.bodyId],
      )).rows[0];
    assertEquals(tombstone.revocation, "revoked");
    assertEquals((tombstone.terminal as { length: number }).length, 0);
    assertEquals(
      (tombstone.terminal as { outcome: string }).outcome,
      "cancelled",
    );
    assertEquals(
      (await f.db.query(
        `SELECT 1 FROM ${f.tables.content_copies} WHERE body_id=$1`,
        [copy.bodyId],
      )).rows.length,
      0,
    );
  } finally {
    await f.close();
  }
});

Deno.test("reviewed ambiguous ownership accepts all candidates or a subset through v14 and binds replay", async () => {
  for (const selected of [["shared-a", "shared-b"], ["shared-b"]]) {
    const f = await fixture();
    try {
      await f.db.query(
        `INSERT INTO ${f.tables.nodes}(id,namespace,type,name,data) VALUES
        ('shared-a','archive','message','a','{"assetId":"shared-asset"}'),
        ('shared-b','archive','long_term_memory','b','{"assetId":"shared-asset"}'),
        ('unrelated','archive','message','unrelated','{}'),
        ('shared-asset','archive','asset','asset','{"state":"ready"}'),
        ('shared-orphan','archive','asset','orphan','{"state":"ready"}'),
        ('shared-execution','archive','@copilotz/action-content','consumer','{"assetIds":["shared-asset","shared-orphan"]}')`,
      );
      const plan = (await prepareRetainedDataUpgrade(f.db, f.schema))!;
      const options = { plan, reviewedFingerprint: plan.fingerprint };
      await assertRejects(
        () => upgradeActionLifecycle(f.db, f.schema, options),
        Error,
        "ambiguous",
      );
      const contentDecisions = [
        { namespace: "archive", assetId: "shared-asset", ownerIds: selected },
        { namespace: "archive", assetId: "shared-orphan", ownerId: null },
      ] as const;
      await assertRejects(
        () =>
          upgradeActionLifecycle(f.db, f.schema, {
            ...options,
            contentDecisions: [
              { ...contentDecisions[0], ownerIds: ["unrelated"] },
              contentDecisions[1],
            ],
          }),
        Error,
        "not a candidate",
      );
      await upgradeActionLifecycle(f.db, f.schema, {
        ...options,
        contentDecisions,
      });
      assertEquals(await marker(f.db, f.schema), 14);
      assertEquals(
        (await f.db.query<{ source_node_id: string }>(
          `SELECT source_node_id FROM ${f.tables.edges} WHERE target_node_id='shared-asset' AND type='has_asset' ORDER BY source_node_id`,
        )).rows.map((r) => r.source_node_id),
        selected,
      );
      await upgradeActionLifecycle(f.db, f.schema, {
        ...options,
        contentDecisions: [
          { ...contentDecisions[0], ownerIds: [...selected].reverse() },
          contentDecisions[1],
        ],
      });
      await assertRejects(
        () =>
          upgradeActionLifecycle(f.db, f.schema, {
            ...options,
            contentDecisions: [
              { ...contentDecisions[0], ownerIds: ["shared-a"] },
              contentDecisions[1],
            ],
          }),
        Error,
        "accepted plan or ownership decisions",
      );
    } finally {
      await f.close();
    }
  }
});
