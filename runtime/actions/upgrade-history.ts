import { createCoreTableNames } from "../events/schema.ts";
import { readEventBody } from "../events/body-store.ts";
import type { SqlExecutor } from "../events/session.ts";

/** Check retained references and original captures before any destructive DDL. */
export async function validateRetainedHistory(
  transaction: SqlExecutor,
  schema: string,
): Promise<void> {
  const tables = createCoreTableNames(schema);
  const broken = await transaction.query<{ kind: string; id: string }>(
    `SELECT 'causation' AS kind, event.id FROM ${tables.events} event
      LEFT JOIN ${tables.events} parent ON parent.id=event.causation_id AND parent.namespace=event.namespace
      WHERE event.causation_id IS NOT NULL AND parent.id IS NULL
    UNION ALL
    SELECT 'graph namespace', edge.id FROM ${tables.edges} edge
      LEFT JOIN ${tables.nodes} source ON source.namespace=edge.namespace AND source.id=edge.source_node_id
      LEFT JOIN ${tables.nodes} target ON target.namespace=edge.namespace AND target.id=edge.target_node_id
      WHERE source.id IS NULL OR target.id IS NULL
        OR source.namespace<>edge.namespace OR target.namespace<>edge.namespace
    UNION ALL
    SELECT 'delivery', delivery.id FROM ${tables.event_deliveries} delivery
      LEFT JOIN ${tables.events} event ON event.id=delivery.event_id WHERE event.id IS NULL
    UNION ALL
    SELECT 'operation event', indexed.event_id FROM "${schema}"."copilotz_operation_events" indexed
      LEFT JOIN ${tables.events} event ON event.id=indexed.event_id AND event.namespace=indexed.namespace
      WHERE event.id IS NULL OR event.position<>indexed.event_position
    UNION ALL
    SELECT 'operation root', operation.operation_id FROM "${schema}"."copilotz_operations" operation
      LEFT JOIN ${tables.events} event ON event.id=operation.root_event_id AND event.namespace=operation.namespace
      WHERE event.id IS NULL
    LIMIT 1`,
  );
  if (broken.rows.length) {
    throw new Error(
      `Retained history has a broken ${broken.rows[0].kind} reference: ${
        broken.rows[0].id
      }.`,
    );
  }
  let after = "0";
  while (true) {
    const events = await transaction.query<{
      id: string;
      position: string | number;
      namespace: string;
      ref: {
        eventBodyId: string;
        schemaVersion: number;
        mediaType: "application/json";
      };
    }>(
      `SELECT id,position,namespace,payload->'dataRef' AS ref FROM ${tables.events}
       WHERE position>$1::bigint AND payload ? 'dataRef' ORDER BY position LIMIT 250`,
      [after],
    );
    for (const event of events.rows) {
      await readEventBody({ transaction, tables }, event.namespace, event.ref);
    }
    if (events.rows.length < 250) break;
    after = String(events.rows.at(-1)!.position);
  }
  // A retained unconverted invocation must never become newly retry-eligible
  // merely because the converted effect inventory starts empty.
  const incomplete = await transaction.query<{ event_body_id: string }>(
    `SELECT invoked.event_body_id FROM ${tables.event_bodies} invoked
     WHERE invoked.body->>'status'='invoked' AND invoked.body->>'actionRunId' IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM ${tables.event_bodies} terminal
         WHERE terminal.namespace=invoked.namespace
           AND terminal.body->>'actionRunId'=invoked.body->>'actionRunId'
           AND terminal.body->>'actionId'=invoked.body->>'actionId'
           AND terminal.body->>'status' IN ('completed','failed','cancelled')) LIMIT 1`,
  );
  if (incomplete.rows.length) {
    throw new Error(
      `Drain existing Action history before upgrading: invocation ${
        incomplete.rows[0].event_body_id
      } has no confirmed terminal. Original replay eligibility is never inferred from an empty effects table.`,
    );
  }
}
