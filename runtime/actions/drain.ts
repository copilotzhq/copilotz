import {
  createCoreTableNames,
  quoteEventIdentifier,
  validateEventSchemaName,
} from "../events/schema.ts";
import type { SqlExecutor } from "../events/session.ts";

export type RetainedDataDrainReport = Readonly<{
  schema: string;
  drained: boolean;
  pending: Readonly<{
    deliveries: number;
    obligations: number;
    operations: number;
    streams: number;
    begunEffects: number;
    physicalWriters: number;
  }>;
  /** Unknown states are deliberately outstanding, never silently terminal. */
  states: Readonly<Record<string, Readonly<Record<string, number>>>>;
}>;

/** Read-only inventory. Stop intake and producers before relying on this report. */
export async function inspectRetainedDataDrain(
  executor: SqlExecutor,
  schemaName = "public",
): Promise<RetainedDataDrainReport> {
  const schema = validateEventSchemaName(schemaName);
  const tables = createCoreTableNames(schema);
  const present = new Set((await executor.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE'",
    [schema],
  )).rows.map((row) => row.table_name));
  for (
    const required of [
      "copilotz_schema_metadata",
      "event_deliveries",
      "copilotz_operations",
      "copilotz_operation_streams",
    ]
  ) {
    if (!present.has(required)) {
      throw new Error(`Cannot certify drain: missing ${schema}.${required}.`);
    }
  }
  const marker = (await executor.query<{ version: number | string }>(
    `SELECT version FROM ${tables.copilotz_schema_metadata} WHERE singleton`,
  )).rows;
  let sourceVersion = Number(marker[0]?.version);
  if (sourceVersion === 0) {
    const staged =
      (await executor.query<{ upgrade_from: number; upgrade_id: string }>(
        `SELECT upgrade_from,upgrade_id FROM ${tables.copilotz_schema_metadata} WHERE singleton`,
      )).rows[0];
    if (!staged?.upgrade_id) {
      throw new Error(
        "Cannot certify drain: interrupted upgrade has no identity.",
      );
    }
    sourceVersion = Number(staged.upgrade_from);
  }
  if (
    marker.length !== 1 || !Number.isInteger(sourceVersion) || sourceVersion < 5
  ) {
    throw new Error("Cannot certify drain: unsupported schema marker.");
  }
  if (sourceVersion >= 6 && !present.has("open_actions")) {
    throw new Error(`Cannot certify drain: missing ${schema}.open_actions.`);
  }
  const checks = [
    ["deliveries", "event_deliveries", "status", [
      "succeeded",
      "cancelled",
      "dead_letter",
    ]],
    ["obligations", "open_actions", "state", []],
    ["operations", "copilotz_operations", "state", [
      "completed",
      "failed",
      "cancelled",
    ]],
    ["streams", "copilotz_operation_streams", "state", ["terminal"]],
    ["begunEffects", "action_effects", "status", ["confirmed", "not_started"]],
    ["physicalWriters", "content_bodies", "state", [
      "ready",
      "incomplete",
      "aborted",
    ]],
  ] as const;
  const pending = {
    deliveries: 0,
    obligations: 0,
    operations: 0,
    streams: 0,
    begunEffects: 0,
    physicalWriters: 0,
  };
  const states: Record<string, Record<string, number>> = {};
  for (const [key, table, column, terminals] of checks) {
    states[key] = {};
    if (!present.has(table)) continue;
    const groups = await executor.query<
      { state: string | null; count: string | number }
    >(
      `SELECT ${
        quoteEventIdentifier(column)
      } AS state, COUNT(*) AS count FROM ${quoteEventIdentifier(schema)}.${
        quoteEventIdentifier(table)
      } GROUP BY ${quoteEventIdentifier(column)}`,
    );
    for (const row of groups.rows) {
      const count = Number(row.count);
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new Error("Drain count exceeds the supported integer range.");
      }
      states[key][row.state ?? "<null>"] = count;
      if (!(terminals as readonly string[]).includes(row.state ?? "")) {
        pending[key] += count;
      }
    }
  }
  return {
    schema,
    drained: Object.values(pending).every((count) => count === 0),
    pending,
    states,
  };
}

export function assertRetainedDataDrained(
  report: RetainedDataDrainReport,
): void {
  if (report.drained) return;
  const outstanding = Object.entries(report.pending)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${kind}=${count}`)
    .join(", ");
  throw Object.assign(
    new Error(
      `Drain existing work on the old runtime before upgrading: ${outstanding}. Deferred/resolving obligations and begun external effects must reach a confirmed terminal; cancellation requests are not sufficient.`,
    ),
    { code: "copilotz_upgrade_not_drained", report },
  );
}
