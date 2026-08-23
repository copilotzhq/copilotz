import type { SqlExecutor } from "../../runtime/events/session.ts";
import { validateEventSchemaName } from "../../runtime/events/schema.ts";

/** The released Gilpinna 0.47/0.48 physical graph, before v4 existed. */
export const LEGACY_GRAPH_V1_COLUMNS = Object.freeze({
  threads: Object.freeze([
    "id",
    "namespace",
    "name",
    "externalId",
    "description",
    "participants",
    "initialMessage",
    "mode",
    "status",
    "summary",
    "parentThreadId",
    "rootThreadId",
    "lastEventId",
    "lastEventAt",
    "workerLockedBy",
    "workerLeaseExpiresAt",
    "createdAt",
    "updatedAt",
  ]),
  events: Object.freeze([
    "id",
    "threadId",
    "eventType",
    "payload",
    "parentEventId",
    "traceId",
    "priority",
    "ttlMs",
    "expiresAt",
    "namespace",
    "status",
    "metadata",
    "createdAt",
    "updatedAt",
    "subjectType",
    "subjectId",
    "operation",
    "causationId",
    "correlationId",
    "dedupeKey",
    "input",
    "before",
    "after",
    "patch",
  ]),
  nodes: Object.freeze([
    "id",
    "namespace",
    "type",
    "name",
    "embedding",
    "content",
    "data",
    "source_type",
    "source_id",
    "created_at",
    "updated_at",
  ]),
  edges: Object.freeze([
    "id",
    "source_node_id",
    "target_node_id",
    "type",
    "data",
    "weight",
    "created_at",
  ]),
});

export type LegacyProfileKind =
  | "legacy-graph-v1"
  | "partial"
  | "final"
  | "in-progress"
  | "unknown";

export type LegacyProfile = Readonly<{
  schema: string;
  kind: LegacyProfileKind;
  tables: readonly string[];
  columns: Readonly<Record<string, readonly string[]>>;
}>;

const LEGACY_TABLES = Object.freeze(Object.keys(LEGACY_GRAPH_V1_COLUMNS));
const V4_CORE_TABLES = Object.freeze([
  "nodes",
  "edges",
  "events",
  "event_bodies",
  "event_deliveries",
  "copilotz_schema_metadata",
]);
const MIGRATION_STATE_TABLE = "copilotz_v4_migration_state";

function sameMembers(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return actual.length === expected.length &&
    actual.every((item) => expected.includes(item));
}

/**
 * Classifies one schema's tables without probing data or performing DDL. The legacy
 * branch is intentionally exact: an added/removed column is not a compatible
 * released profile and must never be archived optimistically.
 */
export async function detectLegacyGraphV1(
  executor: SqlExecutor,
  schemaName = "public",
): Promise<LegacyProfile> {
  const schema = validateEventSchemaName(schemaName);
  const listed = await executor.query<{ table_name: string }>(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = $1 AND table_type = 'BASE TABLE'
      ORDER BY table_name`,
    [schema],
  );
  const tables = listed.rows.map((row) => row.table_name);
  const columnsResult = await executor.query<{
    table_name: string;
    column_name: string;
  }>(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = $1
      ORDER BY table_name, ordinal_position`,
    [schema],
  );
  const columns: Record<string, string[]> = {};
  for (const row of columnsResult.rows) {
    (columns[row.table_name] ??= []).push(row.column_name);
  }

  let kind: LegacyProfileKind;
  if (tables.includes(MIGRATION_STATE_TABLE)) {
    kind = "in-progress";
  } else if (V4_CORE_TABLES.every((table) => tables.includes(table))) {
    kind = "final";
  } else if (
    sameMembers(tables, LEGACY_TABLES) &&
    LEGACY_TABLES.every((table) =>
      sameMembers(
        columns[table] ?? [],
        LEGACY_GRAPH_V1_COLUMNS[table as keyof typeof LEGACY_GRAPH_V1_COLUMNS],
      )
    )
  ) {
    kind = "legacy-graph-v1";
  } else if (tables.some((table) => LEGACY_TABLES.includes(table))) {
    kind = "partial";
  } else {
    kind = "unknown";
  }
  return Object.freeze({
    schema,
    kind,
    tables: Object.freeze([...tables]),
    columns: Object.freeze(
      Object.fromEntries(
        Object.entries(columns).map((
          [table, value],
        ) => [table, Object.freeze([...value])]),
      ),
    ),
  });
}

export function assertLegacyGraphV1(
  profile: LegacyProfile,
): asserts profile is LegacyProfile & { kind: "legacy-graph-v1" } {
  if (profile.kind === "legacy-graph-v1") return;
  throw new Error(
    `v4 migration refuses schema '${profile.schema}' classified as '${profile.kind}'.`,
  );
}
