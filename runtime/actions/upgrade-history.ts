import { createCoreTableNames } from "../events/schema.ts";
import { verifiedEventBody } from "../events/body-store.ts";
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
  const total = Number(
    (await transaction.query<{ count: string }>(
      `SELECT count(*) FROM ${tables.events} WHERE payload ? 'dataRef'`,
    )).rows[0].count,
  );
  let after = "0", done = 0;
  const batchSize = 2000;
  while (true) {
    const events = await transaction.query<{
      position: string | number;
      namespace: string;
      ref: {
        eventBodyId: string;
        schemaVersion: number;
        mediaType: "application/json";
      };
    }>(
      `SELECT e.position,e.namespace,e.payload->'dataRef' AS ref
       FROM ${tables.events} e
       WHERE e.position>$1::bigint AND e.payload ? 'dataRef'
       ORDER BY e.position LIMIT $2`,
      [after, batchSize],
    );
    const keys = events.rows.map((event) => {
      const id = event.ref.eventBodyId.trim();
      if (!id) throw new TypeError("Event body ref is missing eventBodyId.");
      return { namespace: event.namespace, id };
    });
    const bodies = (await transaction.query<{
      namespace: string;
      event_body_id: string;
      body: unknown;
      digest: string;
      schema_version: number;
    }>(
      `SELECT b.namespace,b.event_body_id,b.body,b.digest,b.schema_version
       FROM ${tables.event_bodies} b JOIN
         (SELECT DISTINCT namespace,id FROM jsonb_to_recordset($1::jsonb) AS v(namespace text,id text)) k
         ON b.namespace=k.namespace AND b.event_body_id=k.id`,
      [JSON.stringify(keys)],
    )).rows;
    const byKey = new Map(
      bodies.map((
        body,
      ) => [JSON.stringify([body.namespace, body.event_body_id]), body]),
    );
    for (let i = 0; i < events.rows.length; i++) {
      const event = events.rows[i], key = keys[i];
      const body = byKey.get(JSON.stringify([key.namespace, key.id]));
      if (!body) throw new Error(`Event body '${key.id}' was not found.`);
      await verifiedEventBody(body, event.ref);
    }
    done += events.rows.length;
    console.error(`[upgrade:${schema}] retained history ${done}/${total}`);
    if (events.rows.length < batchSize) break;
    after = String(events.rows.at(-1)!.position);
  }
  // A retained unconverted invocation must never become newly retry-eligible
  // merely because the converted effect inventory starts empty.
  const incomplete = await transaction.query<{ event_body_id: string }>(
    `${unterminatedInvocationsSql(schema)} LIMIT 1`,
  );
  if (incomplete.rows.length) {
    throw new Error(
      `Drain existing Action history before upgrading: invocation ${
        incomplete.rows[0].event_body_id
      } has no confirmed terminal. Original replay eligibility is never inferred from an empty effects table.`,
    );
  }
}

/** Shared upgrade predicate; includes every invoked body in each refused group. */
export function unterminatedInvocationsSql(schema: string): string {
  return `WITH keys AS MATERIALIZED (
       SELECT namespace,event_body_id,body->>'status' AS status,
              body->>'actionRunId' AS run_id,body->>'actionId' AS action_id
       FROM ${createCoreTableNames(schema).event_bodies}
     )
     , incomplete AS (SELECT namespace,run_id,action_id
     FROM keys
     WHERE run_id IS NOT NULL AND status IN ('invoked','completed','failed','cancelled')
     GROUP BY namespace,run_id,action_id
     HAVING bool_or(status='invoked') AND
       (action_id IS NULL OR NOT bool_or(status IN ('completed','failed','cancelled')))
     )
     SELECT k.namespace,k.event_body_id,k.run_id,k.action_id
     FROM keys k JOIN incomplete i ON k.namespace=i.namespace
       AND k.run_id=i.run_id AND k.action_id IS NOT DISTINCT FROM i.action_id
     WHERE k.status='invoked'`;
}
