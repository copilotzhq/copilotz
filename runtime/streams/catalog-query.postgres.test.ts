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
         'discoveryGroup', CASE WHEN scope.namespace = '${SPARSE_NAMESPACE}'
           AND operation_seed.operation_no <> 1599 THEN 'history' ELSE 'unrelated' END,
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
         'discoveryGroup', CASE WHEN scope.namespace = '${SPARSE_NAMESPACE}'
           AND operation_seed.operation_no <> 1599 THEN 'history' ELSE 'unrelated' END,
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
    node["Node Type"] === "Seq Scan" &&
    node["Relation Name"] === relationName &&
    Number(node["Actual Loops"] ?? 0) > 0
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

function relationRows(root: ExplainRoot, relationName: string): number {
  return explainNodes(root).reduce((total, node) => {
    if (node["Relation Name"] !== relationName) return total;
    return total + (Number(node["Actual Rows"] ?? 0) +
          Number(node["Rows Removed by Filter"] ?? 0)) *
        Number(node["Actual Loops"] ?? 1);
  }, 0);
}

function assertCandidateMembershipPlan(root: ExplainRoot): void {
  assert(
    !hasSequentialScan(root, "copilotz_operation_events") &&
      !hasSequentialScan(root, "events"),
    "candidate membership should not scan unrelated event history",
  );
  const nodes = explainNodes(root);
  const hashedSubplans = nodes.flatMap((node) =>
    [...String(node["Filter"] ?? "").matchAll(/hashed SubPlan (\d+)/g)]
      .map((match) => `SubPlan ${match[1]}`)
  );
  assert(
    nodes.every((node) =>
      !hashedSubplans.includes(String(node["Subplan Name"] ?? "")) ||
      Number(node["Actual Loops"] ?? 0) === 0
    ),
    "candidate membership executed a history-wide hashed subplan",
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
        hasIndex(sparsePlan, "copilotz_operations_metadata_idx"),
        "sparse association should use the operation metadata GIN index",
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

      const broadCandidatePlan = await explain(database, {
        scenario: "forced broad candidate discovery",
        queryMs: 0,
        params: [
          SPARSE_NAMESPACE,
          JSON.stringify({ unrelatedGroup: "operation-group-0" }),
          JSON.stringify({ jobGroup: SPARSE_GROUP }),
          25,
        ],
        sql: `WITH candidate AS MATERIALIZED (
          SELECT * FROM ${table(schema, "copilotz_operations")}
            WHERE namespace = $1
        ) SELECT operation.* FROM candidate operation
          WHERE operation.metadata @> $2::jsonb OR EXISTS (
            SELECT 1 FROM ${table(schema, "copilotz_operation_events")} indexed
              JOIN ${
          table(schema, "events")
        } event ON event.id = indexed.event_id
                AND event.namespace = indexed.namespace
              WHERE indexed.namespace = operation.namespace
                AND indexed.operation_id = operation.operation_id
                AND event.metadata @> $3::jsonb OFFSET 0
          ) ORDER BY operation.updated_at DESC, operation.operation_id DESC LIMIT $4`,
      });
      assert(
        bufferCount(sparsePlan) < bufferCount(broadCandidatePlan),
        "initial sparse list should preserve the efficient metadata-index plan",
      );

      const defaultReplayInput = {
        namespace: SPARSE_NAMESPACE,
        states: ["completed"] as const,
        association: {
          operationMetadata: { unrelatedGroup: "operation-group-0" },
          eventMetadata: { jobGroup: SPARSE_GROUP },
        },
      };
      const defaultReplayBaseline = await captureScenario(
        captured,
        "default broad replay baseline",
        () => catalog.list({ ...defaultReplayInput, afterPosition: "0" }),
      );
      const defaultReplay = await captureScenario(
        captured,
        "default positive old replay",
        () => catalog.list({ ...defaultReplayInput, afterPosition: "1" }),
      );
      assertEquals(
        defaultReplay.value.map((operation) => operation.operationId),
        defaultReplayBaseline.value.map((operation) => operation.operationId),
      );
      const defaultReplayBaselinePlan = await explain(
        database,
        defaultReplayBaseline.query,
      );
      const defaultReplayPlan = await explain(database, defaultReplay.query);
      assert(
        hasIndex(defaultReplayPlan, "events_metadata_idx"),
        "positive old replay should keep sparse metadata-index access",
      );
      assert(
        bufferCount(defaultReplayPlan) <=
          bufferCount(defaultReplayBaselinePlan) * 2,
        "default-page old replay regressed compared to metadata-index discovery",
      );

      const denseReplay = await captureScenario(
        captured,
        "dense positive old replay",
        () =>
          catalog.list({
            namespace: DENSE_NAMESPACE,
            afterPosition: "1",
            limit: 20,
            association: {
              operationMetadata: { jobGroup: DENSE_GROUP },
              eventMetadata: { jobGroup: DENSE_GROUP },
            },
          }),
      );
      assertEquals(
        denseReplay.value.map((operation) => operation.operationId),
        denseOperations.map((operation) => operation.operationId),
      );
      const denseReplayPlan = await explain(database, denseReplay.query);
      const denseBaselinePlan = await explain(database, denseRun.query);
      assert(
        bufferCount(denseReplayPlan) <= bufferCount(denseBaselinePlan) * 2,
        "dense old replay regressed compared to broad catalog discovery",
      );
      const broadMissing = await captureScenario(
        captured,
        "broad missing association",
        () =>
          catalog.list({
            namespace: SPARSE_NAMESPACE,
            afterPosition: "1",
            association: { eventMetadata: { jobGroup: "missing" } },
          }),
      );
      assertEquals(broadMissing.value, []);
      const broadMissingPlan = await explain(database, broadMissing.query);
      assert(
        !hasSequentialScan(broadMissingPlan, "events") &&
          !hasSequentialScan(broadMissingPlan, "copilotz_operation_events"),
        "empty broad membership should not scan event history",
      );

      const gateScenarios: Record<string, unknown>[] = [];
      for (
        const [candidateCount, pageLimit] of [[1, 1], [32, 33], [33, 1], [
          33,
          1000,
        ]]
      ) {
        const operationIds = Array.from(
          { length: candidateCount },
          (_, index) => `catalog-op-${index + 1}`,
        );
        const input = {
          namespace: SPARSE_NAMESPACE,
          operationIds,
          association: { eventMetadata: { jobGroup: SPARSE_GROUP } },
          limit: pageLimit,
        };
        const baseline = await captureScenario(
          captured,
          "gate baseline",
          () => catalog.list({ ...input, afterPosition: "0" }),
        );
        const gated = await captureScenario(
          captured,
          "candidate-budget boundary",
          () => catalog.list({ ...input, afterPosition: "1" }),
        );
        assertEquals(
          gated.value.map((operation) => operation.operationId),
          baseline.value.map((operation) => operation.operationId),
        );
        const plan = await explain(database, gated.query);
        const broadAssociationExecuted = explainNodes(plan).some((node) =>
          node["Subplan Name"] === "CTE associated" &&
          Number(node["Actual Loops"] ?? 0) > 0
        );
        assertEquals(
          broadAssociationExecuted,
          candidateCount > 32,
          "candidate work budget must be independent of requested page limit",
        );
        if (candidateCount <= 32) assertCandidateMembershipPlan(plan);
        gateScenarios.push({
          candidateCount,
          pageLimit,
          buffers: bufferCount(plan),
          explainMs: plan["Execution Time"],
          eventRows: relationRows(plan, "events"),
        });
      }

      // Model periodic discovery with almost all history completed. The long
      // running operation has 7,500 indexed events; another running operation
      // is unrelated, and a completed member gets new progress after a fixed
      // watermark. Matching historical events are deliberately common so the
      // old namespace-wide association has to examine substantial history.
      const operationsTable = table(schema, "copilotz_operations");
      const eventsTable = table(schema, "events");
      const indexedTable = table(schema, "copilotz_operation_events");
      await database.query(`UPDATE ${operationsTable}
        SET state = CASE WHEN operation_id IN ('catalog-op-1600', 'catalog-op-1599')
          THEN 'running' ELSE 'completed' END`);
      await database.query(`UPDATE ${operationsTable}
        SET metadata = metadata || '{"discoveryMember":true}'::jsonb
        WHERE operation_id = 'catalog-op-1600'`);
      await database.query(`WITH inserted AS (
        INSERT INTO ${eventsTable} (
          id, schema_version, type, namespace, payload, metadata, correlation_id, created_at
        ) SELECT 'discovery-long-' || event_no, 5, 'catalog.fixture',
          '${SPARSE_NAMESPACE}', '{}', '{"discoveryGroup":"history"}',
          'catalog-correlation-1600', TIMESTAMPTZ '2026-02-01 00:00:00+00'
          FROM generate_series(52, 7499) AS seed(event_no)
          RETURNING namespace, id, position, created_at
      ) INSERT INTO ${indexedTable} (
        namespace, operation_id, event_id, event_position, created_at
      ) SELECT namespace, 'catalog-op-1600', id, position, created_at FROM inserted`);
      const fixedWatermark = await catalog.maxEventPosition({
        namespace: SPARSE_NAMESPACE,
      });
      assert(fixedWatermark);
      await database.query(`WITH inserted AS (
        INSERT INTO ${eventsTable} (
          id, schema_version, type, namespace, payload, metadata, correlation_id, created_at
        ) VALUES ('discovery-late-progress', 5, 'catalog.fixture',
          '${SPARSE_NAMESPACE}', '{}', '{}', 'catalog-correlation-1592',
          TIMESTAMPTZ '2026-03-01 00:00:00+00')
          RETURNING namespace, id, position, created_at
      ) INSERT INTO ${indexedTable} (
        namespace, operation_id, event_id, event_position, created_at
      ) SELECT namespace, 'catalog-op-1592', id, position, created_at FROM inserted`);
      for (const relation of [operationsTable, eventsTable, indexedTable]) {
        await database.query(`ANALYZE ${relation}`);
      }
      const discoveryRun = await captureScenario(
        captured,
        "active/new discovery",
        () =>
          catalog.list({
            namespace: SPARSE_NAMESPACE,
            association: {
              operationMetadata: { discoveryMember: true },
              eventMetadata: { discoveryGroup: "history" },
            },
            afterPosition: fixedWatermark,
            limit: 25,
          }),
      );
      assertEquals(
        discoveryRun.value.map((operation) => operation.operationId),
        ["catalog-op-1600", "catalog-op-1592"],
      );
      const discoveryPlan = await explain(database, discoveryRun.query);
      assertCandidateMembershipPlan(discoveryPlan);
      const discoveryEventRows = relationRows(discoveryPlan, "events");
      assert(
        discoveryEventRows <= 60,
        `discovery examined ${discoveryEventRows} event rows for two bounded membership probes`,
      );

      const hotSmallPageRun = await captureScenario(
        captured,
        "hot discovery limit one",
        () =>
          catalog.list({
            namespace: SPARSE_NAMESPACE,
            afterPosition: fixedWatermark,
            limit: 1,
            association: {
              operationMetadata: { discoveryMember: true },
              eventMetadata: { discoveryGroup: "history" },
            },
          }),
      );
      assertEquals(
        hotSmallPageRun.value.map((operation) => operation.operationId),
        ["catalog-op-1600"],
      );
      const hotSmallPagePlan = await explain(database, hotSmallPageRun.query);
      assertCandidateMembershipPlan(hotSmallPagePlan);
      assert(
        bufferCount(hotSmallPagePlan) <= bufferCount(discoveryPlan) * 1.1,
        "small page must keep the cheap small-candidate plan",
      );

      // Capture the former query shape against exactly the same snapshot/data,
      // including the watermark and OR membership, rather than compare timings
      // across unrelated test cases or rely on planner cost estimates.
      const formerQuery: CapturedQuery = {
        scenario: "former active/new discovery",
        queryMs: 0,
        params: [
          SPARSE_NAMESPACE,
          fixedWatermark,
          JSON.stringify({ discoveryMember: true }),
          JSON.stringify({ discoveryGroup: "history" }),
          25,
        ],
        sql: `WITH associated AS MATERIALIZED (
          SELECT namespace, operation_id FROM ${operationsTable}
            WHERE namespace = $1 AND metadata @> $3::jsonb
          UNION
          SELECT indexed.namespace, indexed.operation_id FROM ${indexedTable} indexed
            JOIN ${eventsTable} event ON event.id = indexed.event_id
              AND event.namespace = indexed.namespace
            WHERE indexed.namespace = $1 AND event.metadata @> $4::jsonb
        ) SELECT operation.* FROM ${operationsTable} operation
          WHERE operation.namespace = $1 AND (
            operation.state IN ('accepted','running') OR EXISTS (
              SELECT 1 FROM ${indexedTable} progress
              WHERE progress.namespace = operation.namespace
                AND progress.operation_id = operation.operation_id
                AND progress.event_position > $2::bigint
            )
          ) AND EXISTS (SELECT 1 FROM associated
            WHERE associated.namespace = operation.namespace
              AND associated.operation_id = operation.operation_id)
          ORDER BY operation.updated_at DESC, operation.operation_id DESC LIMIT $5`,
      };
      const formerRows = await database.query(
        formerQuery.sql,
        formerQuery.params,
      );
      assertEquals(
        formerRows.rows.map((row) => row.operation_id),
        discoveryRun.value.map((operation) => operation.operationId),
      );
      const formerPlan = await explain(database, formerQuery);
      assert(
        relationRows(formerPlan, "events") > 50_000,
        "former query fixture did not exercise historical association amplification",
      );
      assert(
        bufferCount(discoveryPlan) * 2 < bufferCount(formerPlan),
        "candidate discovery did not substantially reduce historical buffer work",
      );

      // Event-only membership still probes the long candidate when its operation
      // metadata cannot answer membership. Bound it by candidate history and
      // preserve empty matches, ID selection, and completed-operation filtering.
      const eventOnlyRun = await captureScenario(
        captured,
        "long event-only membership",
        () =>
          catalog.list({
            namespace: SPARSE_NAMESPACE,
            operationIds: ["catalog-op-1600"],
            afterPosition: fixedWatermark,
            association: { eventMetadata: { discoveryGroup: "missing" } },
          }),
      );
      assertEquals(eventOnlyRun.value, []);
      const eventOnlyPlan = await explain(database, eventOnlyRun.query);
      assertCandidateMembershipPlan(eventOnlyPlan);
      assertEquals(relationRows(eventOnlyPlan, "events"), 7_500);

      // Add 50k matching events to an ineligible completed operation. Discovery
      // work should stay stable even as namespace history grows.
      await database.query(`WITH inserted AS (
        INSERT INTO ${eventsTable} (
          id, schema_version, type, namespace, payload, metadata, correlation_id, created_at
        ) SELECT 'discovery-extra-' || event_no, 5, 'catalog.fixture',
          '${SPARSE_NAMESPACE}', '{}', '{"discoveryGroup":"history"}',
          'catalog-correlation-1598', TIMESTAMPTZ '2026-01-01 00:00:00+00'
          FROM generate_series(1, 50000) AS seed(event_no)
          RETURNING namespace, id, position, created_at
      ) INSERT INTO ${indexedTable} (
        namespace, operation_id, event_id, event_position, created_at
      ) SELECT namespace, 'catalog-op-1598', id, position, created_at FROM inserted`);
      // Simulate a fresh observer after the extra completed history: capture a
      // new fixed watermark, then make the same completed member eligible.
      const largerHistoryWatermark = await catalog.maxEventPosition({
        namespace: SPARSE_NAMESPACE,
      });
      assert(largerHistoryWatermark);
      await database.query(`WITH inserted AS (
        INSERT INTO ${eventsTable} (
          id, schema_version, type, namespace, payload, metadata, correlation_id, created_at
        ) VALUES ('discovery-larger-late-progress', 5, 'catalog.fixture',
          '${SPARSE_NAMESPACE}', '{}', '{}', 'catalog-correlation-1592',
          TIMESTAMPTZ '2026-03-01 00:00:01+00')
          RETURNING namespace, id, position, created_at
      ) INSERT INTO ${indexedTable} (
        namespace, operation_id, event_id, event_position, created_at
      ) SELECT namespace, 'catalog-op-1592', id, position, created_at FROM inserted`);
      for (const relation of [eventsTable, indexedTable]) {
        await database.query(`ANALYZE ${relation}`);
      }
      const largerHistoryQuery = {
        ...discoveryRun.query,
        params: [...discoveryRun.query.params],
      };
      largerHistoryQuery.params[1] = largerHistoryWatermark;
      const largerHistoryRows = await database.query(
        largerHistoryQuery.sql,
        largerHistoryQuery.params,
      );
      assertEquals(
        largerHistoryRows.rows.map((row) => row.operation_id),
        discoveryRun.value.map((operation) => operation.operationId),
      );
      const largerHistoryPlan = await explain(database, largerHistoryQuery);
      assertCandidateMembershipPlan(largerHistoryPlan);
      assertEquals(
        relationRows(largerHistoryPlan, "events"),
        discoveryEventRows,
      );
      assert(
        bufferCount(largerHistoryPlan) <= bufferCount(discoveryPlan) * 1.5,
        "discovery buffers grew with unrelated completed history",
      );
      console.log(JSON.stringify({
        discovery: {
          fixedWatermark,
          candidateEventRows: discoveryEventRows,
          formerEventRows: relationRows(formerPlan, "events"),
          formerIndexedRows: relationRows(
            formerPlan,
            "copilotz_operation_events",
          ),
          buffers: bufferCount(discoveryPlan),
          formerBuffers: bufferCount(formerPlan),
          explainMs: discoveryPlan["Execution Time"],
          formerExplainMs: formerPlan["Execution Time"],
          largerHistoryBuffers: bufferCount(largerHistoryPlan),
        },
        eventOnly: {
          events: relationRows(eventOnlyPlan, "events"),
          buffers: bufferCount(eventOnlyPlan),
          explainMs: eventOnlyPlan["Execution Time"],
        },
      }));
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
        defaultReplay: {
          buffers: bufferCount(defaultReplayPlan),
          baselineBuffers: bufferCount(defaultReplayBaselinePlan),
          explainMs: defaultReplayPlan["Execution Time"],
          baselineExplainMs: defaultReplayBaselinePlan["Execution Time"],
        },
        gateScenarios,
        denseReplay: {
          buffers: bufferCount(denseReplayPlan),
          baselineBuffers: bufferCount(denseBaselinePlan),
          explainMs: denseReplayPlan["Execution Time"],
          baselineExplainMs: denseBaselinePlan["Execution Time"],
        },
        broadMissing: {
          buffers: bufferCount(broadMissingPlan),
          explainMs: broadMissingPlan["Execution Time"],
        },
        broadCandidate: {
          buffers: bufferCount(broadCandidatePlan),
          explainMs: broadCandidatePlan["Execution Time"],
        },
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
