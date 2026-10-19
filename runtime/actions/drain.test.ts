import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import type { SqlExecutor } from "../events/session.ts";
import {
  assertRetainedDataDrained,
  inspectRetainedDataDrain,
} from "./drain.ts";

function fixture(
  groups: Record<string, Record<string, number>> = {},
  missing?: string,
) {
  const queries: string[] = [];
  const tables = [
    "copilotz_schema_metadata",
    "event_deliveries",
    "open_actions",
    "copilotz_operations",
    "copilotz_operation_streams",
    "action_effects",
    "content_bodies",
  ];
  const executor: SqlExecutor = {
    query(sql) {
      queries.push(sql);
      if (sql.includes("information_schema.tables")) {
        return Promise.resolve({
          rows: tables.filter((table) => table !== missing).map((
            table_name,
          ) => ({ table_name })),
        }) as never;
      }
      if (sql.includes("SELECT version")) {
        return Promise.resolve({ rows: [{ version: 7 }] }) as never;
      }
      const table = tables.find((name) => sql.includes(`."${name}"`))!;
      return Promise.resolve({
        rows: Object.entries(groups[table] ?? {}).map(([state, count]) => ({
          state,
          count,
        })),
      }) as never;
    },
  };
  return { executor, queries };
}
Deno.test("drain inventory is read-only and only confirmed terminals are drained", async () => {
  const f = fixture({
    event_deliveries: { succeeded: 3, cancelled: 1, dead_letter: 1 },
    copilotz_operations: { completed: 2, failed: 1, cancelled: 1 },
    copilotz_operation_streams: { terminal: 5 },
    action_effects: { confirmed: 2, not_started: 1 },
    content_bodies: { ready: 2, incomplete: 2, aborted: 1 },
  });
  const report = await inspectRetainedDataDrain(f.executor, "archive");
  assertEquals(report.drained, true);
  assertRetainedDataDrained(report);
  assertEquals(f.queries.every((sql) => sql.startsWith("SELECT")), true);
  assertEquals(
    f.queries.some((sql) =>
      sql.includes(
        'SELECT "status" AS state, COUNT(*) AS count FROM "archive"."action_effects"',
      )
    ),
    true,
  );
});
Deno.test("drain refuses deferred/resolving obligations, cancellation requests, begun effects and unknown states", async () => {
  const f = fixture({
    event_deliveries: { retry_wait: 2 },
    open_actions: { deferred: 1, resolving: 1 },
    copilotz_operations: { running: 1 },
    copilotz_operation_streams: { terminating: 1 },
    action_effects: { begun: 1 },
    content_bodies: { sealing: 1, unknown: 1 },
  });
  const report = await inspectRetainedDataDrain(f.executor, "archive");
  assertEquals(report.pending, {
    deliveries: 2,
    obligations: 2,
    operations: 1,
    streams: 1,
    begunEffects: 1,
    physicalWriters: 2,
  });
  assertThrows(
    () => assertRetainedDataDrained(report),
    Error,
    "cancellation requests are not sufficient",
  );
});
Deno.test("drain never certifies a missing obligation table", async () => {
  await assertRejects(
    () => inspectRetainedDataDrain(fixture({}, "open_actions").executor),
    Error,
    "missing public.open_actions",
  );
});
