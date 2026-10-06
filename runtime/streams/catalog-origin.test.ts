import { assert, assertEquals } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import { provisionCopilotzSchema, type SqlExecutor } from "../events/index.ts";
import {
  createOperationCatalog,
  provisionOperationCatalog,
} from "./catalog.ts";

async function runOriginFixture(url: string) {
  const db = await createTestDatabase({ url });
  const schema = `catalog_origin_${crypto.randomUUID().replaceAll("-", "")}`;
  try {
    await provisionCopilotzSchema(db, schema);
    const tables = await provisionOperationCatalog(db, schema);
    // Canonical receipts and unrelated history are inserted together. Every
    // receipt belongs to exactly one operation, independently of correlation.
    await db.query(`INSERT INTO ${tables.events} (
      id, schema_version, type, namespace, subject_type, subject_id, payload,
      metadata, correlation_id, deduplication_id
    ) SELECT 'event-' || n, 5,
       CASE WHEN n <= 300 THEN 'test.action.invoked' ELSE 'test.noise' END,
       'tenant-a', 'test.action', 'run-' || n, '{}', '{}', 'shared-correlation',
       CASE WHEN n <= 300 THEN 'run-' || n || ':action:invoked' ELSE NULL END
      FROM generate_series(1, 7500) AS n`);
    await db.query(`INSERT INTO ${tables.events} (
      id, schema_version, type, namespace, subject_type, subject_id,
      payload, metadata, correlation_id
    ) SELECT 'other-' || n,5,'test.noise','tenant-a','test.action','other-run-' || n,
      '{}','{}','shared-correlation' FROM generate_series(1,50000) AS n`);
    await db.query(`INSERT INTO ${tables.operationEvents} (
      namespace, operation_id, event_id, event_position, event_ordinal, created_at
    ) SELECT namespace, CASE WHEN id LIKE 'other-%' THEN 'operation-other' ELSE 'operation-a' END,
      id, position, position, created_at FROM ${tables.events}`);
    const executed: Array<{ sql: string; params?: unknown[] }> = [];
    const query: SqlExecutor["query"] = (sql, params) => {
      executed.push({ sql, params });
      return db.query(sql, params);
    };
    const catalog = createOperationCatalog({
      query,
      transaction: db.transaction,
    }, schema);
    const find = (namespace: string, operationId: string, run: string) =>
      catalog.findEventId({
        namespace,
        operationId,
        subjectId: run,
        typeSuffix: ".invoked",
        deduplicationId: `${run}:action:invoked`,
      });
    for (let n = 1; n <= 300; n++) {
      assertEquals(
        await find("tenant-a", "operation-a", `run-${n}`),
        `event-${n}`,
      );
    }
    assertEquals(executed.length, 300);
    await db.query(`ANALYZE ${tables.events}`);
    await db.query(`ANALYZE ${tables.operationEvents}`);
    const canonical = executed[299];
    const explained = await db.query<
      { "QUERY PLAN": Array<{ Plan: Record<string, unknown> }> }
    >(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${canonical.sql}`,
      canonical.params,
    );
    const plan = explained.rows[0]["QUERY PLAN"][0].Plan;
    const serialized = JSON.stringify(plan);
    assert(serialized.includes("events_namespace_dedup_idx"));
    // The fallback must not scan the operation when the receipt identity matches.
    const nodes = (
      node: Record<string, unknown>,
    ): Record<string, unknown>[] => [
      node,
      ...((node.Plans ?? []) as Record<string, unknown>[]).flatMap(nodes),
    ];
    const eventScans = nodes(plan).filter((node) =>
      node["Relation Name"] === "events" ||
      node["Relation Name"] === "copilotz_operation_events"
    );
    const rowsVisited = eventScans.reduce((sum, node) =>
      sum +
      Number(node["Actual Loops"] ?? 0) *
        (Number(node["Actual Rows"] ?? 0) +
          Number(node["Rows Removed by Filter"] ?? 0)), 0);
    assert(rowsVisited <= 2, JSON.stringify(eventScans));
    console.log(
      JSON.stringify({
        lookupStatements: executed.length,
        historyEvents: 57500,
        operationEvents: 7500,
        canonicalPlanRowsVisited: rowsVisited,
        canonicalPlanSharedHitBlocks: plan["Shared Hit Blocks"],
        canonicalPlanSharedReadBlocks: plan["Shared Read Blocks"],
      }),
    );

    assertEquals(await find("tenant-b", "operation-a", "run-1"), undefined);
    assertEquals(await find("tenant-a", "operation-b", "run-1"), undefined);
    const beforeMiss = executed.length;
    assertEquals(await find("tenant-a", "operation-a", "late"), undefined);
    assertEquals(executed.length - beforeMiss, 1);
    const missingQuery = executed.at(-1)!;
    const explainSummary = async (
      scenario: string,
      statement: typeof canonical,
    ) => {
      const result = await db.query<
        { "QUERY PLAN": Array<{ Plan: Record<string, unknown> }> }
      >(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.sql}`,
        statement.params,
      );
      const root = result.rows[0]["QUERY PLAN"][0].Plan;
      const scans = nodes(root).filter((node) => node["Relation Name"]);
      assert(
        scans.filter((node) => node["Relation Name"] === "events")
          .every((node) => node["Node Type"] !== "Seq Scan"),
        JSON.stringify(scans),
      );
      assert(
        scans.filter((node) => node["Relation Name"] === "events")
          .every((node) => Number(node["Actual Loops"] ?? 0) <= 7503),
        JSON.stringify(scans),
      );
      assert(
        scans.filter((node) =>
          node["Relation Name"] === "copilotz_operation_events"
        )
          .every((node) => node["Node Type"] !== "Seq Scan"),
        JSON.stringify(scans),
      );
      console.log(
        JSON.stringify({
          scenario,
          returnedRows: root["Actual Rows"],
          sharedHitBlocks: root["Shared Hit Blocks"],
          sharedReadBlocks: root["Shared Read Blocks"],
          scans: scans.map((node) => ({
            relation: node["Relation Name"],
            index: node["Index Name"],
            loops: node["Actual Loops"],
            rows: node["Actual Rows"],
            filtered: node["Rows Removed by Filter"],
          })),
        }),
      );
      return root;
    };
    assertEquals(
      (await explainSummary("missing", missingQuery))["Actual Rows"],
      0,
    );

    // A matching origin committed after a miss is visible to a fresh lookup.
    // An earlier non-invoked event of the same subject must not win.
    await db.query(`INSERT INTO ${tables.events} (
      id, schema_version, type, namespace, subject_type, subject_id,
      payload, metadata, correlation_id
    ) VALUES ('late-progress',5,'test.action.progress','tenant-a','test.action','late','{}','{}','shared-correlation'),
      ('late-origin',5,'test.action.invoked','tenant-a','test.action','late','{}','{}','shared-correlation'),
      ('late-origin-2',5,'test.action.invoked','tenant-a','test.action','late','{}','{}','shared-correlation')`);
    await db.query(`INSERT INTO ${tables.operationEvents} (
      namespace, operation_id, event_id, event_position, event_ordinal, created_at
    ) SELECT namespace, 'operation-a', id, position, position, created_at
        FROM ${tables.events} WHERE subject_id = 'late'`);
    assertEquals(await find("tenant-a", "operation-a", "late"), "late-origin");
    assertEquals(
      (await explainSummary("legacy-fallback", executed.at(-1)!))[
        "Actual Rows"
      ],
      1,
    );

    // Canonical identity is authoritative for valid current Action receipts.
    // A noncanonical duplicate cannot override it; both namespace and envelope
    // coordinates must still match before that identity suppresses fallback.
    await db.query(`INSERT INTO ${tables.events} (
      id, schema_version, type, namespace, subject_type, subject_id,
      payload, metadata, correlation_id, deduplication_id
    ) VALUES ('late-canonical',5,'test.action.invoked','tenant-a','test.action','late','{}','{}','shared-correlation','late:action:invoked'),
      ('mismatch-canonical',5,'test.action.progress','tenant-a','test.action','mismatch','{}','{}','shared-correlation','mismatch:action:invoked'),
      ('mismatch-origin',5,'test.action.invoked','tenant-a','test.action','mismatch','{}','{}','shared-correlation',NULL)`);
    await db.query(`INSERT INTO ${tables.operationEvents} (
      namespace, operation_id, event_id, event_position, event_ordinal, created_at
    ) SELECT namespace, 'operation-a', id, position, position, created_at
        FROM ${tables.events} WHERE id IN ('late-canonical','mismatch-canonical','mismatch-origin')`);
    assertEquals(
      await find("tenant-a", "operation-a", "late"),
      "late-canonical",
    );
    assertEquals(
      await find("tenant-a", "operation-a", "mismatch"),
      "mismatch-origin",
    );
    assertEquals(
      await catalog.findEventId({
        namespace: "tenant-a",
        operationId: "operation-a",
        subjectId: "late",
        typeSuffix: ".invoked",
      }),
      "late-origin",
    );
  } finally {
    await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.close();
  }
}

Deno.test("scoped origin lookup prefers indexed identity, preserves legacy events and reads a fresh snapshot", () =>
  runOriginFixture(":memory:"));
const POSTGRES_URL = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL")?.trim();
Deno.test({
  name:
    "PostgreSQL scoped origin lookup uses existing indexes and skips fallback for canonical receipts",
  ignore: !POSTGRES_URL,
  fn: () => runOriginFixture(POSTGRES_URL!),
});
