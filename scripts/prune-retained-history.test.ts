import { assert, assertEquals, assertRejects } from "@std/assert";
import { createTestDatabase } from "../runtime/testing/ominipg.ts";
import { restoreRetainedFixture } from "./fixtures/retained-upgrade/load.ts";
import { pruneRetainedHistory } from "./prune-retained-history.ts";
import { inspectRetainedDataDrain } from "../runtime/actions/drain.ts";
import {
  prepareRetainedDataUpgrade,
  upgradeActionLifecycle,
} from "../runtime/actions/upgrade.ts";
import { createOwnerSchemaStatements } from "../runtime/events/schema.ts";
import { validateRetainedHistory } from "../runtime/actions/upgrade-history.ts";
import { encodeEventBody } from "../runtime/events/body-store.ts";
import type { SqlSession } from "../runtime/events/session.ts";

const url = Deno.env.get("PRUNE_TEST_DATABASE_URL") || ":memory:";
if (
  url !== ":memory:" &&
  !/^postgres(?:ql)?:\/\/[^/]+:55439\/prune_[a-z0-9_]+$/.test(url)
) {
  throw new Error("Tests require a prune_* database on PostgreSQL port 55439.");
}
const quiet = () => {};
const families = [
  "copilotz.schedules.tick.*",
  "copilotz.server.*",
  "sandboxEnvironment.updated",
];

async function fixture(version = 7) {
  const db = await createTestDatabase({
    url,
    pgPoolMax: 1,
    requestTimeoutMs: 86_400_000,
  });
  const schema = `prune_${crypto.randomUUID().replaceAll("-", "")}`;
  await restoreRetainedFixture(db, schema);
  if (version === 11) {
    const plan = await prepareRetainedDataUpgrade(db, schema);
    assert(plan);
    await assertRejects(() =>
      upgradeActionLifecycle(db, schema, {
        plan,
        reviewedFingerprint: plan.fingerprint,
      })
    );
    assertEquals(
      Number(
        (await db.query<{ version: number }>(
          `SELECT version FROM "${schema}".copilotz_schema_metadata`,
        )).rows[0].version,
      ),
      11,
    );
  }
  return {
    db,
    schema,
    options: { schema, eventTypes: families, progress: quiet },
    close: async () => {
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.close();
    },
  };
}

/** Set-based synthetic scheduler history, deliberately separate from real data. */
export async function seedNoise(db: SqlSession, schema: string, count: number) {
  const s = `"${schema}"`;
  const hasSeq = (await db.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name='events' AND column_name='seq'`,
    [schema],
  )).rows.length > 0;
  const baseSeq = hasSeq
    ? Number(
      (await db.query<{ n: string }>(
        `SELECT COALESCE(max(seq),0)::text AS n FROM ${s}.events`,
      )).rows[0].n,
    )
    : 0;
  await db.query(
    `INSERT INTO ${s}.event_bodies(namespace,event_body_id,schema_version,body,digest)
    SELECT 'noise','body-noise-'||n,1,body::jsonb,'sha256:'||encode(sha256(convert_to(body,'UTF8')),'hex')
    FROM (SELECT n, '{"actionId":"'||
      CASE WHEN n%6 IN (0,1) THEN 'copilotz.schedules.tick' ELSE 'copilotz.server.internal.invoke' END ||
      '","actionRunId":"'|| CASE WHEN n%6 IN (0,1) THEN 'tick-run-' ELSE 'invoke-run-' END ||(n/6)||
      '","input":'||CASE WHEN n%6 IN (0,1) THEN '{}' ELSE '{"actionAlias":"tick","requestId":"request-'||(n/6)||'"}' END||
      ',"metadata":{}'||CASE WHEN n%6=1 THEN ',"output":{}' WHEN n%6=4 THEN ',"output":{"status":"completed","targetActionRunId":"tick-run-'||(n/6)||'"}' ELSE '' END||CASE WHEN n%6 IN (0,1) THEN ',"parentActionRunId":"invoke-run-'||(n/6)||'"' ELSE '' END||
      ',"status":"'||CASE WHEN n%6 IN (0,3) THEN 'invoked' ELSE 'completed' END||'"}' AS body
      FROM generate_series(0,$1::integer-1) n WHERE n%6 IN (0,1,3,4)) b`,
    [count],
  );
  await db.query(
    `INSERT INTO ${s}.events
    (id,schema_version,type,namespace,subject_type,subject_id,payload,metadata,causation_id,correlation_id${
      hasSeq ? ",seq" : ""
    })
    SELECT 'noise-'||n,7,
      CASE n%6 WHEN 0 THEN 'copilotz.schedules.tick.invoked'
        WHEN 1 THEN 'copilotz.schedules.tick.completed'
        WHEN 2 THEN 'copilotz.schedules.tick.input'
        WHEN 3 THEN 'copilotz.server.internal.invoke.invoked'
        WHEN 4 THEN 'copilotz.server.internal.invoke.completed'
        ELSE 'sandboxEnvironment.updated' END,
      'noise', CASE WHEN n%6 IN (0,1) THEN 'copilotz.schedules.tick'
        WHEN n%6 IN (3,4) THEN 'copilotz.server.internal.invoke' ELSE NULL END,
      CASE WHEN n%6 IN (0,1) THEN 'tick-run-'||(n/6)
        WHEN n%6 IN (3,4) THEN 'invoke-run-'||(n/6) ELSE NULL END,
      CASE WHEN n%6 IN (0,1,3,4) THEN jsonb_build_object('dataRef',jsonb_build_object('eventBodyId','body-noise-'||n,'schemaVersion',1,'mediaType','application/json')) ELSE '{}'::jsonb END,
      CASE WHEN n%6 IN (0,1,3,4) THEN jsonb_build_object(
        'actionId',CASE WHEN n%6 IN (0,1) THEN 'copilotz.schedules.tick' ELSE 'copilotz.server.internal.invoke' END,
        'actionStatus',CASE WHEN n%6 IN (0,3) THEN 'invoked' ELSE 'completed' END)
        ELSE '{}'::jsonb END,
      CASE WHEN n%6 IN (1,2) THEN 'noise-'||(n- n%6)
        WHEN n%6=4 THEN 'noise-'||(n-1) ELSE NULL END, 'correlation-'||n ${
      hasSeq ? `,n+${baseSeq}+1` : ""
    }
    FROM generate_series(0,$1::integer-1) n`,
    [count],
  );
  await db.query(
    `INSERT INTO ${s}.event_deliveries(id,event_id,consumer_id,settlement_scope_id,status)
    SELECT 'delivery-'||id,id,'synthetic',id,'succeeded' FROM ${s}.events WHERE namespace='noise' AND substring(id from 7)::integer%6=0`,
  );
  await db.query(`INSERT INTO ${s}.copilotz_operations
    (operation_id,namespace,root_event_id,correlation_id,state,accepted_at,updated_at,completed_at)
    SELECT id,'noise',id,id,'completed',now(),now(),now()
    FROM ${s}.events WHERE namespace='noise' AND type='copilotz.schedules.tick.invoked'`);
  await db.query(
    `INSERT INTO ${s}.copilotz_operation_events(namespace,operation_id,event_id,event_position,event_ordinal,created_at)
    SELECT 'noise','noise-'||((substring(id from 7)::integer/6)*6),id,position,
      (substring(id from 7)::integer%6)+1,created_at FROM ${s}.events
    WHERE namespace='noise' AND substring(id from 7)::integer%6 IN (0,1,2)`,
  );
}

async function digests(db: SqlSession, schema: string, realOnly = false) {
  const tables = (await db.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema=$1 AND table_type='BASE TABLE' ORDER BY table_name",
    [schema],
  )).rows;
  const result: Record<string, string> = {};
  for (const { table_name: name } of tables) {
    const filter = realOnly
      ? `WHERE COALESCE(to_jsonb(t)->>'namespace','')<>'noise'
      AND COALESCE(to_jsonb(t)->>'event_id','') NOT LIKE 'noise-%'
      AND COALESCE(to_jsonb(t)->>'id','') NOT LIKE 'delivery-noise-%'`
      : "";
    result[name] = (await db.query<{ digest: string }>(
      `SELECT md5(COALESCE(string_agg(v,'' ORDER BY v),'')) AS digest
      FROM (SELECT to_jsonb(t)::text AS v FROM "${schema}"."${name}" t ${filter}) x`,
    )).rows[0].digest;
  }
  return result;
}

for (const version of [7, 11]) {
  Deno.test(`v${version}: exhaustive refusal, closure, resume and idempotence`, async () => {
    const f = await fixture(version);
    const s = `"${f.schema}"`;
    try {
      await seedNoise(f.db, f.schema, 120);
      // Every blocker has its own connected history, making reasons auditable.
      for (
        const [n, status] of [[0, "pending"], [6, "leased"], [
          12,
          "retry_wait",
        ]] as const
      ) {
        await f.db.query(
          `UPDATE ${s}.event_deliveries SET status=$1 WHERE event_id=$2`,
          [status, `noise-${n}`],
        );
      }
      await f.db.query(
        `UPDATE ${s}.copilotz_operations SET state='running',completed_at=NULL WHERE operation_id='noise-18'`,
      );
      await f.db.query(`INSERT INTO ${s}.nodes(id,namespace,type,name,data)
        VALUES ('message','noise','message','retained message','{"eventId":"noise-24"}'),
          ('asset','noise','asset','retained asset','{"operationId":"noise-30"}'),
          ('secret','noise','protected_value','retained value','{"eventId":"noise-36"}')`);
      await f.db.query(
        `INSERT INTO ${s}.edges(id,namespace,source_node_id,target_node_id,type,data)
        VALUES('edge','noise','message','asset','link','{"eventId":"noise-42"}')`,
      );
      await f.db.query(
        `INSERT INTO ${s}.open_actions(namespace,action_run_id,action_id,scope_id,invoked_event_id,state)
        VALUES('noise','open-run','synthetic','noise-48','noise-48','invoked')`,
      );
      // v7 may have additive owner tables; never infer safety from its marker.
      if (version === 7) {
        for (
          const ddl of createOwnerSchemaStatements(f.schema, { version: 11 })
        ) await f.db.query(ddl);
      }
      await f.db.query(
        `INSERT INTO ${s}.owner_alarms(owner,name,due_at) VALUES('schema','["noise","noise-54"]',now())`,
      );
      await f.db.query(
        `INSERT INTO ${s}.owner_deadlines(owner,source,key,namespace,due_at,payload)
        VALUES('schema','synthetic','deadline','noise',now(),'{"operationId":"noise-60"}')`,
      );
      const body = await encodeEventBody({ value: "retained body" });
      await f.db.query(
        `INSERT INTO ${s}.event_bodies(namespace,event_body_id,schema_version,body,digest)
        VALUES('noise','shared-body',1,$1::jsonb,$2)`,
        [body.body, body.digest],
      );
      await f.db.query(
        `ALTER TABLE ${s}.events DISABLE TRIGGER copilotz_events_immutable`,
      );
      await f.db.query(
        `UPDATE ${s}.events SET payload='{"dataRef":{"eventBodyId":"shared-body","schemaVersion":1,"mediaType":"application/json"}}' WHERE id='noise-66'`,
      );
      await f.db.query(
        `ALTER TABLE ${s}.events ENABLE TRIGGER copilotz_events_immutable`,
      );
      await f.db.query(
        `INSERT INTO ${s}.nodes(id,namespace,type,name,data) VALUES('body-reference','noise','message','body reference','{"eventBodyId":"shared-body"}')`,
      );
      await f.db.query(
        `CREATE TABLE ${s}.extension_reference(id integer PRIMARY KEY, unusual text REFERENCES ${s}.events(id) ON DELETE CASCADE)`,
      );
      await f.db.query(
        `INSERT INTO ${s}.extension_reference VALUES(1,'noise-72')`,
      );
      await f.db.query(
        `INSERT INTO ${s}.action_effects(namespace,action_run_id,step,status) VALUES('noise','tick-run-13','step','begun')`,
      );
      await f.db.query(
        `INSERT INTO ${s}.owner_receipts(owner,domain,key,principal,kind,intent,result)
        VALUES('schema','logical','receipt','synthetic','synthetic','{"operationId":"noise-84"}','{}')`,
      );
      await f.db.query(
        `INSERT INTO ${s}.copilotz_operation_selections(namespace,selection_key,operation_id,change_ordinal)
        VALUES('noise','exclusive','noise-84',1),('noise','shared','noise-90',1),('noise','shared','noise-18',2)`,
      );
      await f.db.query(
        `INSERT INTO ${s}.copilotz_operation_selection_heads VALUES('noise','exclusive',1),('noise','shared',2)`,
      );
      const before = await digests(f.db, f.schema);
      const dry = await pruneRetainedHistory(f.db, f.options);
      assertEquals(await digests(f.db, f.schema), before);
      for (let n = 0; n <= 78; n += 6) {
        assert(
          dry.refusals.some((r) => r.eventId === `noise-${n}`),
          `missing refusal ${n}`,
        );
      }
      for (
        const needle of [
          "pending",
          "leased",
          "retry_wait",
          "operation",
          "nodes",
          "edges",
          "open_actions",
          "owner_alarms",
          "owner_deadlines",
          "extension_reference",
          "effect",
        ]
      ) {
        assert(
          dry.refusals.some((r) =>
            r.reasons.some((reason) => reason.includes(needle))
          ),
          needle,
        );
      }
      assertEquals(dry.deleteCounts.owner_receipts, 1);
      assertEquals(dry.deleteCounts.copilotz_operation_selection_heads, 1);
      await assertRejects(
        () => pruneRetainedHistory(f.db, { ...f.options, apply: true }),
        Error,
        "writers-stopped",
      );
      const applied = await pruneRetainedHistory(f.db, {
        ...f.options,
        apply: true,
        writersStopped: true,
        batchSize: 23,
      });
      assertEquals(applied.deleteCounts, dry.deleteCounts);
      assertEquals(applied.typesAfter, dry.typesAfter);
      assertEquals(applied.refusals, dry.refusals);
      const again = await pruneRetainedHistory(f.db, {
        ...f.options,
        apply: true,
        writersStopped: true,
      });
      assert(Object.values(again.deleteCounts).every((n) => n === 0));
      // Pruning must not make outstanding work appear drained.
      assertEquals(
        (await inspectRetainedDataDrain(f.db, f.schema)).drained,
        false,
      );
      await assertRejects(() => prepareRetainedDataUpgrade(f.db, f.schema));
    } finally {
      await f.close();
    }
  });
}

for (const version of [7, 11]) {
  Deno.test(`v${version}: terminal selection, action identity, version and unknown schema fail closed`, async () => {
    const f = await fixture(version);
    try {
      await seedNoise(f.db, f.schema, 12);
      const s = `"${f.schema}"`;
      const request = await encodeEventBody({
        schema: "copilotz.server.action-request.v1",
        requestId: "request-0",
        actionAlias: "tick",
        input: {},
        actionMetadata: {},
      });
      await f.db.query(
        `INSERT INTO ${s}.event_bodies(namespace,event_body_id,schema_version,body,digest)
      VALUES('noise','request-body',1,$1::jsonb,$2)`,
        [request.body, request.digest],
      );
      await f.db.query(
        `INSERT INTO ${s}.events(id,schema_version,type,namespace,payload,correlation_id${
          version === 11 ? ",seq" : ""
        })
      VALUES('request-event-0',7,'copilotz.server.action.requested','noise',
        '{"dataRef":{"eventBodyId":"request-body","schemaVersion":1,"mediaType":"application/json"}}','request-0'
        ${version === 11 ? `,(SELECT max(seq)+1 FROM ${s}.events)` : ""})`,
      );
      await f.db.query(
        `ALTER TABLE ${s}.events DISABLE TRIGGER copilotz_events_immutable`,
      );
      await f.db.query(
        `UPDATE ${s}.events SET causation_id='request-event-0',metadata=metadata||'{"sourceEventId":"request-event-0"}'::jsonb
      WHERE id IN ('noise-3','noise-4')`,
      );
      await f.db.query(
        `ALTER TABLE ${s}.events ENABLE TRIGGER copilotz_events_immutable`,
      );
      await validateRetainedHistory(f.db, f.schema);
      const matching = await pruneRetainedHistory(f.db, {
        ...f.options,
        actionIds: ["copilotz.schedules.tick"],
      });
      assertEquals(matching.deleteCounts.events, 13);

      const half = await pruneRetainedHistory(f.db, {
        ...f.options,
        eventTypes: ["copilotz.schedules.tick.invoked"],
      });
      assertEquals(half.deleteCounts.events, 0);
      assertEquals(half.refusals.length, 2);
      const terminalOnly = await pruneRetainedHistory(f.db, {
        ...f.options,
        eventTypes: ["copilotz.schedules.tick.completed"],
      });
      assertEquals(terminalOnly.deleteCounts.events, 0);
      const filtered = await pruneRetainedHistory(f.db, {
        ...f.options,
        actionIds: ["unrelated"],
      });
      assertEquals(filtered.deleteCounts.events, 2);
      const original = await digests(f.db, f.schema, true);
      await assertRejects(
        () =>
          pruneRetainedHistory(f.db, {
            ...f.options,
            apply: true,
            writersStopped: true,
            batchSize: 1,
            afterBatch: () => {
              throw new Error("synthetic interruption");
            },
          }),
        Error,
        "synthetic interruption",
      );
      const resumed = await pruneRetainedHistory(f.db, {
        ...f.options,
        apply: true,
        writersStopped: true,
      });
      assert(resumed.deleteCounts.events < 13);
      assertEquals(await digests(f.db, f.schema, true), original);
      assertEquals(
        (await inspectRetainedDataDrain(f.db, f.schema)).drained,
        true,
      );
      if (version === 7) {
        const plan = await prepareRetainedDataUpgrade(f.db, f.schema);
        assertEquals(plan?.sourceVersion, 7);
        await assertRejects(
          () => pruneRetainedHistory(f.db, f.options),
          Error,
          "Unsupported retained schema version 0",
        );
      } else {
        await assertRejects(
          () => prepareRetainedDataUpgrade(f.db, f.schema),
          Error,
          "owner-key migration",
        );
      }
      await f.db.query(
        `UPDATE "${f.schema}".copilotz_schema_metadata SET version=14`,
      );
      await assertRejects(
        () => pruneRetainedHistory(f.db, f.options),
        Error,
        "Unsupported retained schema version 14",
      );
    } finally {
      await f.close();
    }
  });
}

Deno.test("large synthetic history preserves real records and permits drain and prepare", async () => {
  const count = Number(Deno.env.get("PRUNE_TEST_EVENTS") ?? 100002);
  assert(count >= 100000 && count % 6 === 0);
  const f = await fixture();
  try {
    const seedStart = performance.now();
    await seedNoise(f.db, f.schema, count);
    const seedMs = Math.round(performance.now() - seedStart);
    // Large mixed fixture: real records and all their blocked history survive.
    const s = `"${f.schema}"`;
    await f.db.query(
      `UPDATE ${s}.event_deliveries SET status='pending' WHERE event_id='noise-0'`,
    );
    await f.db.query(
      `UPDATE ${s}.copilotz_operations SET state='running',completed_at=NULL WHERE operation_id='noise-6'`,
    );
    await f.db.query(`INSERT INTO ${s}.nodes(id,namespace,type,name,data) VALUES
      ('retained-message-0','archive','message','retained message','{"eventId":"noise-0"}'),
      ('retained-message-6','archive','message','retained message','{"operationId":"noise-6"}'),
      ('retained-message-12','archive','message','retained message','{"eventBodyId":"body-noise-12"}')`);
    const protectedHistory = async () => {
      const result: Record<string, unknown> = {};
      const ids = [0, 6, 12].flatMap((root) =>
        [0, 1, 2, 3, 4].map((offset) => `noise-${root + offset}`)
      );
      for (
        const [name, column, values] of [
          ["events", "id", ids],
          ["event_bodies", "event_body_id", ids.map((id) => `body-${id}`)],
          ["event_deliveries", "event_id", ids],
          ["copilotz_operations", "root_event_id", ids],
          ["copilotz_operation_events", "event_id", ids],
        ] as const
      ) {
        result[name] = (await f.db.query(
          `SELECT to_jsonb(t) AS row FROM ${s}."${name}" t
        WHERE "${column}"=ANY($1::text[]) ORDER BY to_jsonb(t)::text`,
          [values],
        )).rows;
      }
      return result;
    };
    const protectedBefore = await protectedHistory();
    const original = await digests(f.db, f.schema, true);
    const dry = await pruneRetainedHistory(f.db, f.options);
    assertEquals(dry.deleteCounts.events, count - 15);
    const applied = await pruneRetainedHistory(f.db, {
      ...f.options,
      apply: true,
      writersStopped: true,
    });
    assertEquals(applied.deleteCounts, dry.deleteCounts);
    assertEquals(applied.typesAfter, dry.typesAfter);
    assertEquals(await digests(f.db, f.schema, true), original);
    assertEquals(await protectedHistory(), protectedBefore);
    assertEquals(
      (await inspectRetainedDataDrain(f.db, f.schema)).drained,
      false,
    );
    const after = await pruneRetainedHistory(f.db, {
      ...f.options,
      apply: true,
      writersStopped: true,
    });
    assertEquals(after.deleteCounts.events, 0);
    // Explicit synthetic settlement, not a pruner side effect. Real references
    // continue protecting these histories after their outstanding work closes.
    await f.db.query(
      `UPDATE ${s}.event_deliveries SET status='succeeded',settled_at=now() WHERE event_id='noise-0'`,
    );
    await f.db.query(
      `UPDATE ${s}.copilotz_operations SET state='completed',completed_at=now() WHERE operation_id='noise-6'`,
    );
    assertEquals(
      (await inspectRetainedDataDrain(f.db, f.schema)).drained,
      true,
    );
    await validateRetainedHistory(f.db, f.schema);
    const prepareStart = performance.now();
    assertEquals(
      (await prepareRetainedDataUpgrade(f.db, f.schema))?.sourceVersion,
      7,
    );
    console.log(
      JSON.stringify({
        events: count,
        backend: url === ":memory:" ? "PGlite" : "PostgreSQL",
        seedMs,
        dryRunMs: dry.elapsedMs,
        applyMs: applied.elapsedMs,
        prepareMs: Math.round(performance.now() - prepareStart),
        batches: applied.committedBatches,
        tupleBytesDeleted: applied.tupleBytesDeleted,
      }),
    );
  } finally {
    await f.close();
  }
});

Deno.test("catalog references, shared receipts, streams, authorization and transaction rollback", async () => {
  const f = await fixture();
  const s = `"${f.schema}"`;
  const external = `${f.schema}_external`;
  try {
    await seedNoise(f.db, f.schema, 60);
    for (const ddl of createOwnerSchemaStatements(f.schema, { version: 11 })) {
      await f.db.query(ddl);
    }
    const { authorizationSchemaStatements } = await import(
      "../runtime/authorization/schema.ts"
    );
    for (const ddl of authorizationSchemaStatements(f.schema)) {
      await f.db.query(ddl);
    }
    await f.db.query(`CREATE SCHEMA "${external}"`);
    await f.db.query(
      `CREATE TABLE "${external}".references_history(value bigint REFERENCES ${s}.events(position) ON DELETE CASCADE)`,
    );
    await f.db.query(
      `INSERT INTO "${external}".references_history SELECT position FROM ${s}.events WHERE id='noise-0'`,
    );
    const stream = (await f.db.query(
      `SELECT * FROM ${s}.copilotz_operation_streams LIMIT 1`,
    )).rows[0];
    for (const n of [6, 12]) {
      const row = {
        ...stream,
        namespace: "noise",
        operation_id: `noise-${n}`,
        replay_key: 1000 + n,
        stream_id: `synthetic-stream-${n}`,
        semantic_stream_id: `synthetic-semantic-${n}`,
        body_id: `synthetic-body-${n}`,
        asset_id: null,
        asset_retention: null,
        ...(n === 6
          ? { state: "open", outcome: null, capture: null, terminal_at: null }
          : {}),
      };
      await f.db.query(
        `INSERT INTO ${s}.copilotz_operation_streams SELECT * FROM jsonb_populate_record(NULL::${s}.copilotz_operation_streams,$1::jsonb)`,
        [JSON.stringify(row)],
      );
    }
    const realEvent = (await f.db.query<{ id: string }>(
      `SELECT id FROM ${s}.events WHERE namespace='archive' LIMIT 1`,
    )).rows[0].id;
    await f.db.query(
      `INSERT INTO ${s}.owner_receipts(owner,domain,key,principal,kind,intent,result)
      VALUES('schema','logical','shared-receipt','synthetic','synthetic','{"operationId":"noise-18"}',$1::jsonb)`,
      [JSON.stringify({ eventId: realEvent })],
    );
    await f.db.query(
      `INSERT INTO ${s}.owner_receipts(owner,domain,key,principal,kind,intent,result)
      VALUES('schema','logical','referenced-receipt','synthetic','synthetic','{"operationId":"noise-36"}','{}')`,
    );
    await f.db.query(`INSERT INTO ${s}.nodes(id,namespace,type,name,data)
      VALUES('receipt-reference','archive','message','receipt reference','{"receiptKey":"referenced-receipt"}')`);
    await f.db.query(
      `INSERT INTO ${s}.authorization_invocations(namespace,run_id,source_event_id,authority)
      VALUES('noise','tick-run-4','noise-24','{}')`,
    );
    await f.db.query(
      `INSERT INTO ${s}.authorization_effects(namespace,tenant,effect_key,run_id,operation_id,initiator,method,intent,claims)
      VALUES('noise','synthetic','effect','tick-run-4','noise-24','synthetic','synthetic','{}','{}')`,
    );
    await f.db.query(
      `INSERT INTO ${s}.action_effects(namespace,action_run_id,step,status,outcome)
      VALUES('noise','tick-run-4','confirmed-step','confirmed','{}')`,
    );
    await f.db.query(
      `INSERT INTO ${s}.events(id,schema_version,type,namespace,payload,correlation_id,causation_id)
      VALUES('real-descendant',7,'message.created','noise','{}','real-correlation','noise-30')`,
    );
    const dry = await pruneRetainedHistory(f.db, f.options);
    for (const n of [0, 6, 18, 30, 36]) {
      assert(dry.refusals.some((r) => r.eventId === `noise-${n}`));
    }
    assert(
      dry.refusals.some((r) =>
        r.reasons.some((reason) => reason.includes(external))
      ),
    );
    assertEquals(dry.deleteCounts.authorization_effects, 1);
    assertEquals(dry.deleteCounts.authorization_invocations, 1);
    assertEquals(dry.deleteCounts.action_effects, 1);
    assertEquals(dry.deleteCounts.copilotz_operation_streams, 1);
    assertEquals(dry.deleteCounts.owner_receipts, 0);
    const before = await digests(f.db, f.schema);
    let deletes = 0;
    const interrupted: SqlSession = {
      query: f.db.query,
      transaction: (run) =>
        f.db.transaction((tx) =>
          run({
            query: async (sql, params) => {
              const result = await tx.query(sql, params);
              if (sql.includes("WITH deleted AS") && ++deletes === 1) {
                throw new Error("interrupt inside transaction");
              }
              return result as never;
            },
          })
        ),
    };
    await assertRejects(
      () =>
        pruneRetainedHistory(interrupted, {
          ...f.options,
          apply: true,
          writersStopped: true,
        }),
      Error,
      "interrupt inside transaction",
    );
    assertEquals(await digests(f.db, f.schema), before);
    const applied = await pruneRetainedHistory(f.db, {
      ...f.options,
      apply: true,
      writersStopped: true,
    });
    assertEquals(applied.deleteCounts, dry.deleteCounts);
    const after = await digests(f.db, f.schema);
    for (const [name, n] of Object.entries(dry.deleteCounts)) {
      if (n === 0 && name in before) {
        assertEquals(after[name], before[name], name);
      }
    }
    assertEquals(
      (await f.db.query(`SELECT * FROM "${external}".references_history`)).rows
        .length,
      1,
    );
  } finally {
    await f.db.query(`DROP SCHEMA IF EXISTS "${external}" CASCADE`);
    await f.close();
  }
});
