import { assert, assertEquals } from "@std/assert";
import {
  createSchemaCommandRunner,
  openDatabaseOwner,
  releaseDatabaseOwner,
} from "../engine/commands.ts";
import { invalidateOwnerAlarm } from "../engine/alarms.ts";
import {
  createEventCoordinator,
  createEventStore,
  createSqlSession,
  provisionCopilotzSchema,
} from "../events/index.ts";
import { createDeliveryExecutor } from "../execution/index.ts";
import { createPluginRegistry } from "../plugins/index.ts";
import { provisionOperationCatalog } from "../streams/catalog.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createTestProcessorContext } from "../testing/processor-context.ts";
import { createMemoryBodyStore } from "./body-store.ts";
import { createBodyStorageRuntime } from "./storage.ts";
import { createDatabaseAssetRepository } from "./database-repository.ts";
import { createContentCatalog } from "./catalog.ts";
import { digestContent } from "./digest.ts";

const schema = "content_retirement_test";
const namespace = "tenant";
const prefix = `copilotz/schemas/${schema}/content-streams/`;

async function fixture() {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
  });
  const trace: string[] = [];
  const session = createSqlSession({
    query: db.query,
    transaction: (run) =>
      db.transaction((tx) =>
        run({
          query(sql, parameters) {
            trace.push(sql);
            return tx.query(sql, parameters);
          },
        })
      ),
  });
  if (Deno.env.get("COPILOTZ_TEST_POSTGRES_URL")) {
    await session.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  }
  await provisionCopilotzSchema(session, schema);
  let time = Date.now();
  const now = () => new Date(time);
  const timers = new Map<number, () => void>();
  let serial = 0;
  const owner = await openDatabaseOwner(session, schema, {
    now,
    alarmScheduler: {
      schedule(callback) {
        timers.set(++serial, callback);
        return serial;
      },
      cancel(handle) {
        timers.delete(handle as number);
      },
    },
  });
  await provisionOperationCatalog(session, schema);
  const store = createEventStore({ session, schema });
  const registry = await createPluginRegistry({ plugins: [] });
  const executor = createDeliveryExecutor({
    store,
    registry,
    workerId: "content-retirement",
    createContext: createTestProcessorContext,
  });
  const coordinator = createEventCoordinator({ store, registry, executor });
  const memory = createMemoryBodyStore({ backendId: "memory:retirement" });
  const physical = {
    ...memory,
    head: memory.head,
  };
  const assets = createDatabaseAssetRepository({
    session,
    databaseSchema: schema,
    eventStore: store,
    coordinator,
    now,
    storage: createBodyStorageRuntime({
      storage: {
        type: "custom",
        config: {
          store: physical,
          prefix: "copilotz",
          deployment: {
            durability: "ephemeral",
            reach: "process",
            readyGarbageCollection: true,
          },
        },
      },
    }),
  });
  const run = createSchemaCommandRunner(session, schema);
  const bytes = new TextEncoder().encode("terminal");
  const digest = await digestContent(bytes);
  const mutate = (sql: string, parameters?: unknown[]) =>
    run("test.retention", {}, async (_, { transaction }) => {
      await transaction.query(sql, parameters);
      invalidateOwnerAlarm(transaction, schema, "content");
    });
  let wakes = 0;
  owner.registerAlarmSource({
    name: "content",
    nextDeadline: (tx) => assets.catalog.nextDeadline(tx),
    async wake() {
      wakes++;
      await assets.maintainBodies({ now: now(), orphanAfterMs: 0 });
    },
  });
  owner.activate();
  await owner.rearmAlarms();
  return {
    assets,
    memory,
    physical,
    session,
    owner,
    trace,
    timers,
    now,
    mutate,
    wakes: () => wakes,
    advance(ms: number) {
      time += ms;
    },
    async seed(count: number) {
      const bodies: { id: string; token: string }[] = [];
      for (let i = 0; i < count; i++) {
        const id = `${prefix}incarnation:test:action:llm.call:route:${i}`;
        const head = await memory.put({
          bodyId: id,
          bytes,
          mediaType: "text/plain",
          digest,
        });
        bodies.push({ id, token: head.versionToken });
      }
      await run("test.seed", {}, async (_, { transaction }) => {
        await transaction.query(
          `INSERT INTO "${schema}".content_logical_bodies
            (body_id,namespace,current_copy,writer_id,generation,protected_until,terminal)
           SELECT id,$2,id,id,1,NOW()-INTERVAL '1 day',
             jsonb_build_object('outcome','completed','length',8,'digest',$3::text)
           FROM jsonb_to_recordset($1::jsonb) AS b(id text,token text)`,
          [JSON.stringify(bodies), namespace, digest],
        );
        await transaction.query(
          `INSERT INTO "${schema}".content_copies
            (copy_key,backend_kind,backend_id,body_id,version_token,state,collectable,retire_after)
           SELECT id,$2,$3,id,token,'current',TRUE,NOW()-INTERVAL '1 hour'
           FROM jsonb_to_recordset($1::jsonb) AS b(id text,token text)`,
          [JSON.stringify(bodies), memory.kind, memory.backendId],
        );
      });
      return bodies.map((body) => body.id);
    },
    async close() {
      await executor.shutdown();
      await releaseDatabaseOwner(owner);
      await db.close();
    },
  };
}

Deno.test("protected terminal streams stay idle across simulated maintenance and retire after release", async () => {
  const f = await fixture();
  try {
    const ids = await f.seed(60);
    const expiresAt = new Date(f.now().getTime() + 86400000).toISOString();
    await f.mutate(
      `INSERT INTO "${schema}".nodes(namespace,id,type,name,data)
       SELECT namespace,body_id,'asset','terminal',jsonb_build_object('state','ready','bodyId',body_id)
       FROM "${schema}".content_logical_bodies`,
    );
    await f.mutate(
      `INSERT INTO "${schema}".pending_content(namespace,pending_ref,body_id,producer,descriptor,expires_at)
       SELECT namespace,body_id,body_id,'settled','{}',$1 FROM "${schema}".content_logical_bodies`,
      [expiresAt],
    );
    assertEquals(await f.assets.catalog.nextDeadline(), expiresAt);
    f.trace.length = 0;
    // Exercise both scheduled wakes and unrelated maintenance for an idle hour.
    // No isBodyRetained callback is supplied: catalog protection is mandatory.
    for (let minute = 0; minute < 60; minute++) {
      f.advance(60000);
      await f.owner.wakeAlarms();
      await f.assets.maintainBodies({ now: f.now(), orphanAfterMs: 0 });
    }
    assertEquals(f.wakes(), 0);
    const retirementCommands = f.trace.filter((sql) =>
      sql.includes("SELECT body_id,state") ||
      sql.includes("SET retire_after=") ||
      sql.includes("SET completed=TRUE")
    );
    assertEquals(retirementCommands.length, 0);
    assertEquals(await f.assets.catalog.nextDeadline(), expiresAt);
    for (const id of ids) assert(await f.memory.head({ bodyId: id }));

    // Expiring pending descriptors alone cannot release ready asset protection.
    await f.mutate(
      `UPDATE "${schema}".pending_content SET expires_at=NOW()-INTERVAL '1 second'`,
    );
    await f.assets.maintainBodies({ now: f.now(), orphanAfterMs: 0 });
    assertEquals(await f.assets.catalog.nextDeadline(), null);
    // Removing the last ready reference re-arms retirement, with no retry timer.
    await f.mutate(
      `UPDATE "${schema}".nodes SET data=data || '{"state":"deleted"}'::jsonb`,
    );
    assert(
      Date.parse((await f.assets.catalog.nextDeadline())!) <= f.now().getTime(),
    );
    await f.owner.wakeAlarms();
    assertEquals(f.wakes(), 1);
    for (const id of ids) {
      assertEquals(await f.memory.head({ bodyId: id }), null);
    }
    assertEquals(await f.assets.catalog.nextDeadline(), null);
  } finally {
    await f.close();
  }
});

Deno.test("asset deletion invalidates a quiet content alarm and releases its copy", async () => {
  const f = await fixture();
  try {
    const asset = await f.assets.publish({
      namespace,
      id: "owned",
      body: new TextEncoder().encode("owned"),
      mediaType: "text/plain",
    });
    await f.mutate(
      `UPDATE "${schema}".content_logical_bodies SET protected_until=NOW()-INTERVAL '1 day'`,
    );
    await f.mutate(
      `UPDATE "${schema}".content_copies SET retire_after=NOW()-INTERVAL '1 day'`,
    );
    assertEquals(await f.assets.catalog.nextDeadline(), null);
    assertEquals(f.timers.size, 0);
    const copy = (await f.assets.catalog.read(asset.bodyId))!.copy;
    f.advance(1000);
    await f.assets.markDeleted(namespace, asset.id);
    assert(f.timers.size > 0);
    await f.owner.wakeAlarms();
    assertEquals(await f.memory.head({ bodyId: copy.key }), null);
    assertEquals(await f.assets.catalog.nextDeadline(), null);
  } finally {
    await f.close();
  }
});

Deno.test("unknown store results honor durable retry deadlines and eventually retire", async () => {
  const f = await fixture();
  try {
    const [id] = await f.seed(1);
    let attempts = 0;
    f.physical.head = (input) => {
      attempts++;
      return attempts === 1
        ? Promise.reject(new Error("store unavailable"))
        : attempts === 2
        ? Promise.resolve(null)
        : f.memory.head(input);
    };
    await f.assets.maintainBodies({ now: f.now(), orphanAfterMs: 0 });
    assertEquals(attempts, 1);
    const retry = await f.assets.catalog.nextDeadline();
    assertEquals(retry, new Date(f.now().getTime() + 1000).toISOString());
    // Reconstructing the catalog cannot reset the persisted deadline.
    assertEquals(
      await createContentCatalog(f.session, schema).nextDeadline(),
      retry,
    );
    for (let i = 0; i < 5; i++) {
      await f.assets.maintainBodies({ now: f.now(), orphanAfterMs: 0 });
    }
    assertEquals(attempts, 1);
    assertEquals(await f.assets.catalog.nextDeadline(), retry);
    f.advance(1000);
    await f.assets.maintainBodies({ now: f.now(), orphanAfterMs: 0 });
    assertEquals(attempts, 2);
    assert(await f.memory.head({ bodyId: id }));
    assertEquals(
      await f.assets.catalog.nextDeadline(),
      new Date(f.now().getTime() + 1000).toISOString(),
    );
    f.advance(1000);
    assertEquals(
      await f.assets.maintainBodies({ now: f.now(), orphanAfterMs: 0 }),
      { orphanedBodiesDeleted: 1 },
    );
    assertEquals(await f.memory.head({ bodyId: id }), null);
    // Retired catalog rows are never probed again.
    const finishedAttempts = attempts;
    await f.assets.maintainBodies({ now: f.now(), orphanAfterMs: 0 });
    assertEquals(attempts, finishedAttempts);
    assertEquals(await f.assets.catalog.nextDeadline(), null);
  } finally {
    await f.close();
  }
});

Deno.test("retirement candidates follow protection expiry, producer settlement and stream retention", async () => {
  const f = await fixture();
  try {
    const ids = await f.seed(5);
    const protectedUntil = new Date(f.now().getTime() + 3600000).toISOString();
    const expiresAt = new Date(f.now().getTime() + 86400000).toISOString();
    await f.mutate(
      `UPDATE "${schema}".content_logical_bodies SET protected_until=$2 WHERE body_id=$1`,
      [ids[0], protectedUntil],
    );
    await f.mutate(
      `INSERT INTO "${schema}".pending_content(namespace,pending_ref,body_id,producer,descriptor,expires_at)
       VALUES($1,'pending',$2,'settled','{}',$3),($1,'producing',$4,'running','{}',NOW()-INTERVAL '1 day')`,
      [namespace, ids[1], expiresAt, ids[3]],
    );
    await f.mutate(
      `INSERT INTO "${schema}".copilotz_operations
       (namespace,operation_id,root_event_id,correlation_id,state,accepted_at,updated_at)
       VALUES($1,'running','running','running','running',NOW(),NOW())`,
      [namespace],
    );
    await f.mutate(
      `INSERT INTO "${schema}".copilotz_operation_streams
       (namespace,operation_id,stream_ordinal,stream_id,semantic_stream_id,body_id,descriptor,state,outcome,terminal_at)
       VALUES($1,'settled',1,'retained','retained',$2,'{}','terminal','completed',NOW())`,
      [namespace, ids[2]],
    );
    await f.mutate(
      `INSERT INTO "${schema}".nodes(namespace,id,type,name,data)
       VALUES($1,'protected','protected_value','protected',jsonb_build_object('state','ready','bodyId',$2::text))`,
      [namespace, ids[4]],
    );
    assertEquals(
      await f.assets.catalog.retirementCandidates({ now: f.now() }),
      [],
    );
    assertEquals(await f.assets.catalog.nextDeadline(), protectedUntil);
    await f.assets.maintainBodies({ now: f.now(), orphanAfterMs: 0 });
    for (const id of ids) assert(await f.memory.head({ bodyId: id }));
    // Pending producer protection survives descriptor expiry and maintenance.
    assertEquals(
      (await f.session.query(
        `SELECT pending_ref FROM "${schema}".pending_content WHERE pending_ref='producing'`,
      )).rows.length,
      1,
    );

    // Advance the simulated candidate clock to the finite protection deadline.
    f.advance(3600000);
    assertEquals(
      (await f.assets.catalog.retirementCandidates({ now: f.now() })).map((
        copy,
      ) => copy.bodyId),
      [ids[0]],
    );
    await f.mutate(
      `UPDATE "${schema}".content_logical_bodies SET protected_until=NOW()-INTERVAL '1 day'`,
    );
    await f.mutate(
      `UPDATE "${schema}".pending_content SET expires_at=NOW()-INTERVAL '1 day'`,
    );
    await f.mutate(
      `UPDATE "${schema}".copilotz_operations SET state='completed'`,
    );
    await f.mutate(
      `UPDATE "${schema}".copilotz_operation_streams SET cleanup_state='pending'`,
    );
    await f.mutate(
      `UPDATE "${schema}".nodes SET data=data || '{"state":"deleted"}'::jsonb`,
    );
    assertEquals(
      (await f.assets.catalog.retirementCandidates({ now: f.now() })).map((
        copy,
      ) => copy.bodyId),
      ids,
    );
    assertEquals(
      await f.assets.maintainBodies({
        now: f.now(),
        orphanAfterMs: 0,
        // hasStreamBody still sees retained streams while cleanup is pending.
        // Catalog eligibility must win over this store-discovery callback.
        isBodyRetained: () => Promise.resolve(true),
      }),
      { orphanedBodiesDeleted: 5 },
    );
    assertEquals(await f.assets.catalog.nextDeadline(), null);
    for (const id of ids) {
      assertEquals(await f.memory.head({ bodyId: id }), null);
    }
  } finally {
    await f.close();
  }
});
