import { assert, assertEquals } from "@std/assert";
import {
  provisionCopilotzSchema,
  quoteEventIdentifier,
  type SqlSession,
} from "../events/index.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import {
  createOperationCatalog,
  provisionOperationCatalog,
} from "./catalog.ts";

const POSTGRES_URL = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL")?.trim();
const EVENT_COUNT = 4_600 * 52;
const OPERATION_COUNT = 4_600;
const SPARSE_NAMESPACE = "tenant-sparse";
const DENSE_NAMESPACE = "tenant-dense";
const SPARSE_GROUP = "sparse-old";
const DENSE_GROUP = "dense-common";

type CapturedQuery = Readonly<{
  scenario: string;
  sql: string;
  params: unknown[];
  queryMs: number;
}>;

type ExecutedQuery = Omit<CapturedQuery, "scenario">;

type ExplainNode = {
  [key: string]: unknown;
  Plans?: ExplainNode[];
};

type ExplainRoot = {
  Plan: ExplainNode;
  "Execution Time"?: number;
  "Planning Time"?: number;
};

function table(schema: string, name: string): string {
  return `${quoteEventIdentifier(schema)}.${quoteEventIdentifier(name)}`;
}

function capturingSession(
  database: SqlSession,
  captured: ExecutedQuery[],
): SqlSession {
  return {
    async query<TRow extends Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ) {
      const started = performance.now();
      const result = await database.query<TRow>(sql, params);
      captured.push({
        sql,
        params: [...(params ?? [])],
        queryMs: performance.now() - started,
      });
      return result;
    },
    transaction(operation) {
      return database.transaction(operation);
    },
  };
}

async function captureScenario<T>(
  captured: ExecutedQuery[],
  scenario: string,
  operation: () => Promise<T>,
): Promise<Readonly<{ value: T; query: CapturedQuery }>> {
  captured.length = 0;
  const value = await operation();
  assertEquals(
    captured.length,
    1,
    `${scenario} should issue one catalog read query`,
  );
  return {
    value,
    query: { ...captured[0], scenario },
  };
}

function generatedFixtureSql(schema: string): readonly string[] {
  const operations = table(schema, "copilotz_operations");
  const events = table(schema, "events");
  const operationEvents = table(schema, "copilotz_operation_events");
  const operationSeed = `
    FROM generate_series(1, ${OPERATION_COUNT}) AS operation_seed(operation_no)
  `;
  const eventSeed = `
    FROM generate_series(1, ${OPERATION_COUNT}) AS operation_seed(operation_no)
    CROSS JOIN generate_series(0, 51) AS event_seed(event_no)
    CROSS JOIN LATERAL (
      SELECT
        CASE
          WHEN operation_seed.operation_no <= 1600 THEN '${SPARSE_NAMESPACE}'
          WHEN operation_seed.operation_no <= 3400 THEN '${DENSE_NAMESPACE}'
          ELSE 'tenant-other'
        END AS namespace,
        CASE
          WHEN operation_seed.operation_no <= 1600 THEN 'sparse'
          WHEN operation_seed.operation_no <= 3400 THEN 'dense'
          ELSE 'other'
        END AS tenant_class
    ) AS scope
  `;

  return [
    `INSERT INTO ${operations} (
       operation_id, namespace, root_event_id, correlation_id, metadata,
       state, accepted_at, updated_at
     )
     SELECT
       'catalog-op-' || operation_seed.operation_no,
       CASE
         WHEN operation_seed.operation_no <= 1600 THEN '${SPARSE_NAMESPACE}'
         WHEN operation_seed.operation_no <= 3400 THEN '${DENSE_NAMESPACE}'
         ELSE 'tenant-other'
       END,
       'catalog-event-' || operation_seed.operation_no || '-0',
       'catalog-correlation-' || operation_seed.operation_no,
       jsonb_build_object(
         'tenantClass', CASE
           WHEN operation_seed.operation_no <= 1600 THEN 'sparse'
           WHEN operation_seed.operation_no <= 3400 THEN 'dense'
           ELSE 'other'
         END,
         'jobGroup', CASE
           WHEN operation_seed.operation_no <= 1600 THEN '${SPARSE_GROUP}'
           WHEN operation_seed.operation_no <= 3400 THEN '${DENSE_GROUP}'
           ELSE 'other-job'
         END,
         'cohort', 'cohort-' || (operation_seed.operation_no % 257),
         'unrelatedGroup', 'operation-group-' || (operation_seed.operation_no % 113)
       ),
       CASE operation_seed.operation_no % 7
         WHEN 0 THEN 'accepted'
         WHEN 1 THEN 'running'
         WHEN 2 THEN 'completed'
         WHEN 3 THEN 'failed'
         WHEN 4 THEN 'cancelled'
         ELSE 'running'
       END,
       TIMESTAMPTZ '2026-01-01 00:00:00+00' +
         (operation_seed.operation_no || ' seconds')::interval,
       TIMESTAMPTZ '2026-01-01 00:00:00+00' +
         (operation_seed.operation_no || ' seconds')::interval
     ${operationSeed}`,
    `INSERT INTO ${events} (
       id, schema_version, type, namespace, payload, metadata,
       correlation_id, created_at
     )
     SELECT
       'catalog-event-' || operation_seed.operation_no || '-' || event_seed.event_no,
       5,
       'catalog.fixture',
       scope.namespace,
       jsonb_build_object('operationNo', operation_seed.operation_no, 'eventNo', event_seed.event_no),
       jsonb_build_object(
         'tenantClass', scope.tenant_class,
         'jobGroup', '${SPARSE_GROUP}',
         'eventKind', 'root',
         'cohort', 'cohort-' || ((operation_seed.operation_no * 31) % 257),
         'unrelatedGroup', 'unrelated-' || ((operation_seed.operation_no * 97) % 1021)
       ),
       'catalog-correlation-' || operation_seed.operation_no,
       TIMESTAMPTZ '2026-01-01 00:00:00+00' +
         ((operation_seed.operation_no * 52 + event_seed.event_no) || ' seconds')::interval
     ${eventSeed}
     WHERE scope.namespace = '${SPARSE_NAMESPACE}'
       AND operation_seed.operation_no % 8 = 0
       AND event_seed.event_no = 0`,
    `INSERT INTO ${events} (
       id, schema_version, type, namespace, payload, metadata,
       correlation_id, created_at
     )
     SELECT
       'catalog-event-' || operation_seed.operation_no || '-' || event_seed.event_no,
       5,
       'catalog.fixture',
       scope.namespace,
       jsonb_build_object('operationNo', operation_seed.operation_no, 'eventNo', event_seed.event_no),
       jsonb_build_object(
         'tenantClass', scope.tenant_class,
         'jobGroup', CASE
           WHEN scope.namespace = '${DENSE_NAMESPACE}' AND event_seed.event_no % 2 = 0
             THEN '${DENSE_GROUP}'
           WHEN scope.namespace = '${SPARSE_NAMESPACE}' THEN 'sparse-tail'
           ELSE 'other-job-' || ((operation_seed.operation_no + event_seed.event_no) % 401)
         END,
         'eventKind', CASE WHEN event_seed.event_no = 0 THEN 'root' ELSE 'progress' END,
         'cohort', 'cohort-' || ((operation_seed.operation_no * 31 + event_seed.event_no) % 257),
         'unrelatedGroup', 'unrelated-' || ((operation_seed.operation_no * 97 + event_seed.event_no) % 1021)
       ),
       'catalog-correlation-' || operation_seed.operation_no,
       TIMESTAMPTZ '2026-01-01 00:00:00+00' +
         ((operation_seed.operation_no * 52 + event_seed.event_no) || ' seconds')::interval
     ${eventSeed}
     WHERE NOT (
       scope.namespace = '${SPARSE_NAMESPACE}'
       AND operation_seed.operation_no % 8 = 0
       AND event_seed.event_no = 0
     )`,
    `INSERT INTO ${operationEvents} (
       namespace, operation_id, event_id, event_position, created_at
     )
     SELECT
       event.namespace,
       'catalog-op-' || split_part(event.id, '-', 3),
       event.id,
       event.position,
       event.created_at
     FROM ${events} AS event
     WHERE event.id LIKE 'catalog-event-%'`,
    `ANALYZE ${events}`,
    `ANALYZE ${operations}`,
    `ANALYZE ${operationEvents}`,
  ];
}

function explainPayload(value: unknown): ExplainRoot {
  if (typeof value === "string") return explainPayload(JSON.parse(value));
  if (Array.isArray(value)) return explainPayload(value[0]);
  if (!value || typeof value !== "object") {
    throw new Error("PostgreSQL returned an invalid EXPLAIN JSON payload.");
  }
  const payload = value as Record<string, unknown>;
  if (payload.Plan && typeof payload.Plan === "object") {
    return payload as ExplainRoot;
  }
  const nested = payload["QUERY PLAN"];
  if (nested !== undefined) return explainPayload(nested);
  const first = Object.values(payload)[0];
  if (first !== undefined) return explainPayload(first);
  throw new Error("PostgreSQL returned an empty EXPLAIN JSON payload.");
}

function explainNodes(root: ExplainRoot): ExplainNode[] {
  const nodes: ExplainNode[] = [];
  const visit = (node: ExplainNode) => {
    nodes.push(node);
    for (const child of node.Plans ?? []) visit(child);
  };
  visit(root.Plan);
  return nodes;
}

function hasIndex(root: ExplainRoot, indexName: string): boolean {
  return explainNodes(root).some((node) => node["Index Name"] === indexName);
}

function hasSequentialScan(root: ExplainRoot, relationName: string): boolean {
  return explainNodes(root).some((node) =>
    node["Node Type"] === "Seq Scan" && node["Relation Name"] === relationName
  );
}

function rowsRemovedByFilter(root: ExplainRoot, relationName: string): number {
  return explainNodes(root).reduce(
    (removed, node) =>
      removed +
      (node["Relation Name"] === relationName &&
          typeof node["Rows Removed by Filter"] === "number"
        ? (node["Rows Removed by Filter"] as number) *
          (typeof node["Actual Loops"] === "number"
            ? node["Actual Loops"] as number
            : 1)
        : 0),
    0,
  );
}

function bufferCount(root: ExplainRoot): number {
  const hit = root.Plan["Shared Hit Blocks"];
  const read = root.Plan["Shared Read Blocks"];
  if (typeof hit === "number" || typeof read === "number") {
    return (typeof hit === "number" ? hit : 0) +
      (typeof read === "number" ? read : 0);
  }
  return explainNodes(root).reduce(
    (count, node) =>
      count +
      (typeof node["Shared Hit Blocks"] === "number"
        ? node["Shared Hit Blocks"] as number
        : 0) +
      (typeof node["Shared Read Blocks"] === "number"
        ? node["Shared Read Blocks"] as number
        : 0),
    0,
  );
}

async function explain(
  database: SqlSession,
  query: CapturedQuery,
): Promise<ExplainRoot> {
  const result = await database.query(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`,
    query.params,
  );
  return explainPayload(result.rows[0]);
}

Deno.test({
  name: "PostgreSQL catalog queries stay bounded on a realistic event catalog",
  ignore: !POSTGRES_URL,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const schema = `catalog_query_pg_${
      crypto.randomUUID().replaceAll("-", "")
    }`;
    const database = await createTestDatabase({ url: POSTGRES_URL! });
    const captured: ExecutedQuery[] = [];
    const measuredQueries: CapturedQuery[] = [];
    try {
      await provisionCopilotzSchema(database, schema);
      await provisionOperationCatalog(database, schema);
      for (const statement of generatedFixtureSql(schema)) {
        await database.query(statement);
      }
      const fixtureCounts = await database.query<{
        operations: string;
        events: string;
        indexed_events: string;
      }>(`SELECT
          (SELECT count(*)::text FROM ${
        table(schema, "copilotz_operations")
      }) AS operations,
          (SELECT count(*)::text FROM ${table(schema, "events")}) AS events,
          (SELECT count(*)::text FROM ${
        table(schema, "copilotz_operation_events")
      }) AS indexed_events`);
      assertEquals(fixtureCounts.rows[0], {
        operations: String(OPERATION_COUNT),
        events: String(EVENT_COUNT),
        indexed_events: String(EVENT_COUNT),
      });

      const catalog = createOperationCatalog(
        capturingSession(database, captured),
        schema,
      );
      const sparseStarted = performance.now();
      const sparseRun = await captureScenario(
        captured,
        "sparse association",
        () =>
          catalog.list({
            namespace: SPARSE_NAMESPACE,
            association: {
              operationMetadata: { unrelatedGroup: "operation-group-0" },
              eventMetadata: { jobGroup: SPARSE_GROUP },
            },
            afterPosition: "0",
            limit: 25,
          }),
      );
      const sparseOperations = sparseRun.value;
      const sparseMs = performance.now() - sparseStarted;
      const sparseQuery = sparseRun.query;
      measuredQueries.push(sparseQuery);
      assertEquals(sparseOperations.length, 25);
      assertEquals(sparseOperations[0]?.operationId, "catalog-op-1600");
      assert(
        sparseOperations.every((operation) => {
          const operationNo = Number(
            operation.operationId.slice("catalog-op-".length),
          );
          return operation.namespace === SPARSE_NAMESPACE &&
            (operationNo % 8 === 0 || operationNo % 113 === 0);
        }),
        "sparse association returned an unrelated operation",
      );

      const watermarkStarted = performance.now();
      const watermarkRun = await captureScenario(
        captured,
        "sparse watermark",
        () =>
          catalog.maxEventPosition({
            namespace: SPARSE_NAMESPACE,
            eventMetadata: { jobGroup: SPARSE_GROUP },
          }),
      );
      const watermark = watermarkRun.value;
      const watermarkMs = performance.now() - watermarkStarted;
      const watermarkQuery = watermarkRun.query;
      measuredQueries.push(watermarkQuery);
      assertEquals(watermark, "200");

      const membershipStarted = performance.now();
      const membershipRun = await captureScenario(
        captured,
        "single-operation membership",
        () =>
          catalog.list({
            namespace: SPARSE_NAMESPACE,
            operationIds: ["catalog-op-1600"],
            association: { eventMetadata: { jobGroup: SPARSE_GROUP } },
            afterPosition: "0",
            limit: 10,
          }),
      );
      const membership = membershipRun.value;
      const membershipMs = performance.now() - membershipStarted;
      const membershipQuery = membershipRun.query;
      measuredQueries.push(membershipQuery);
      assertEquals(membership.length, 1);
      assertEquals(membership[0]?.operationId, "catalog-op-1600");

      const denseRun = await captureScenario(
        captured,
        "dense association",
        () =>
          catalog.list({
            namespace: DENSE_NAMESPACE,
            association: {
              operationMetadata: { jobGroup: DENSE_GROUP },
              eventMetadata: { jobGroup: DENSE_GROUP },
            },
            limit: 20,
          }),
      );
      const denseOperations = denseRun.value;
      measuredQueries.push(denseRun.query);
      assertEquals(denseOperations.length, 20);
      assert(
        denseOperations.every((operation) =>
          operation.namespace === DENSE_NAMESPACE
        ),
        "dense association returned an unrelated namespace",
      );

      const sparsePlan = await explain(database, sparseQuery!);
      const watermarkPlan = await explain(database, watermarkQuery!);
      const membershipPlan = await explain(database, membershipQuery!);
      const sparseNodes = explainNodes(sparsePlan);
      const watermarkNodes = explainNodes(watermarkPlan);

      assert(
        hasIndex(sparsePlan, "events_metadata_idx"),
        "sparse association should use the canonical events_metadata_idx",
      );
      assert(
        hasIndex(watermarkPlan, "events_metadata_idx"),
        "sparse watermark should use the canonical events_metadata_idx",
      );
      assert(
        !hasSequentialScan(sparsePlan, "events") &&
          !hasSequentialScan(sparsePlan, "copilotz_operation_events"),
        "sparse association performed an unrelated event/progress scan",
      );
      assert(
        !hasSequentialScan(watermarkPlan, "events"),
        "sparse watermark performed an unrelated event scan",
      );
      assert(
        !hasSequentialScan(membershipPlan, "events") &&
          !hasSequentialScan(membershipPlan, "copilotz_operation_events"),
        "single-operation membership performed an unrelated event/progress scan",
      );

      const watermarkRowsRemoved = rowsRemovedByFilter(watermarkPlan, "events");
      assert(
        watermarkRowsRemoved < 1_000,
        `sparse watermark filtered too many unrelated rows (${watermarkRowsRemoved})`,
      );

      console.log(JSON.stringify({
        fixture: { operations: OPERATION_COUNT, events: EVENT_COUNT },
        sparse: {
          returned: sparseOperations.length,
          queryMs: Math.round(sparseMs * 100) / 100,
          explainMs: sparsePlan["Execution Time"],
          buffers: bufferCount(sparsePlan),
        },
        watermark: {
          position: watermark,
          queryMs: Math.round(watermarkMs * 100) / 100,
          explainMs: watermarkPlan["Execution Time"],
          buffers: bufferCount(watermarkPlan),
          rowsRemovedByFilter: watermarkRowsRemoved,
        },
        membership: {
          returned: membership.length,
          queryMs: Math.round(membershipMs * 100) / 100,
          explainMs: membershipPlan["Execution Time"],
          buffers: bufferCount(membershipPlan),
        },
        capturedQueries: measuredQueries.map((query) => query.scenario),
        sparsePlanNodes: sparseNodes.length,
        watermarkPlanNodes: watermarkNodes.length,
      }));
    } finally {
      await database.query(
        `DROP SCHEMA IF EXISTS ${quoteEventIdentifier(schema)} CASCADE`,
      ).catch(() => undefined);
      await database.close();
    }
  },
});
