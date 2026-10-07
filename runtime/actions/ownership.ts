import type { CoreTableName } from "../events/schema.ts";
import type { EventStatement } from "../events/store.ts";
import type { ActionLifecycleAppendInput } from "./types.ts";

/** Execution authority is transient; retry receipts keep their original bytes. */
export type ActionWriter =
  | Readonly<{ kind: "delivery"; deliveryId: string; leaseOwner: string }>
  | Readonly<{ kind: "recovery"; deliveryId: string }>
  | Readonly<{ kind: "cancellation"; namespace: string; operationId: string }>;

export class ActionOwnershipLost extends Error {
  constructor(runId: string) {
    super(`Action '${runId}' is no longer owned by this execution.`);
    this.name = "ActionOwnershipLost";
  }
}

/** The live obligation is a small projection of the immutable receipt. */
export function actionOwnershipStatement(
  input: ActionLifecycleAppendInput,
  writer: ActionWriter | undefined,
  tables: Readonly<Record<CoreTableName, string>>,
  param: (value: unknown) => string,
): EventStatement<void> {
  const { data, draft } = input;
  if (data.status === "deferred" && writer?.kind !== "delivery") {
    throw new TypeError("Deferred Actions require a durable delivery owner.");
  }
  // Live/direct calls have no durable lease to recover after a crash. Their
  // receipts remain observable, but only delivery-owned work is an obligation.
  if (!writer) {
    return {
      ctes: [],
      gate: "TRUE",
      effects: () => [],
      report: "NULL",
      resolve() {},
    };
  }
  const namespace = param(draft.namespace);
  const runId = param(data.actionRunId);
  const cancellation = writer?.kind === "cancellation";
  if (
    cancellation &&
    (data.status !== "cancelled" || writer.namespace !== draft.namespace ||
      writer.operationId !== draft.settlementScopeId)
  ) throw new TypeError("Invalid Action cancellation authority.");
  const delivery = cancellation
    ? "NULL::text"
    : param(writer?.deliveryId ?? null);
  const ctes: string[] = [];
  if (writer && writer.kind !== "cancellation") {
    ctes.push(`action_writer AS MATERIALIZED (
      SELECT id FROM ${tables.event_deliveries}
      WHERE id = ${delivery} AND EXISTS (SELECT 1 FROM event_admission) AND ${
      writer.kind === "delivery"
        ? `status = 'leased' AND lease_owner = ${
          param(writer.leaseOwner)
        } AND lease_expires_at > NOW()`
        : "status IN ('dead_letter', 'cancelled', 'succeeded')"
    }
      FOR UPDATE
    )`);
  }
  ctes.push(`action_obligation AS MATERIALIZED (
    SELECT * FROM ${tables.open_actions}
    WHERE namespace = ${namespace} AND action_run_id = ${runId}
      AND EXISTS (SELECT 1 FROM ${
    writer && !cancellation ? "action_writer" : "event_admission"
  })
    FOR UPDATE
  )`);
  const owner = cancellation
    ? `scope_id = ${param(writer.operationId)}`
    : `owner_delivery_id IS NOT DISTINCT FROM ${delivery}::text`;
  const stateGate = data.status === "invoked"
    ? `(NOT EXISTS (SELECT 1 FROM action_obligation) OR EXISTS (
        SELECT 1 FROM action_obligation WHERE state = 'invoked' AND ${owner}
      ))`
    : cancellation
    ? `EXISTS (SELECT 1 FROM action_obligation WHERE ${owner})`
    : `EXISTS (SELECT 1 FROM action_obligation WHERE state IN (${
      data.status === "deferred" ? "'invoked'" : "'invoked','resolving'"
    }) AND ${owner})`;
  const gate = `${
    writer && !cancellation ? "EXISTS (SELECT 1 FROM action_writer) AND " : ""
  }${stateGate}`;
  const terminal = ["completed", "failed", "cancelled"].includes(data.status);
  return {
    ctes,
    gate,
    effects: (source) =>
      data.status === "invoked"
        ? [`opened_action AS (
          INSERT INTO ${tables.open_actions} (
            namespace, action_run_id, action_id, scope_id, invoked_event_id, state, owner_delivery_id, action_scope_id
          ) SELECT ${namespace}, ${runId}, ${param(data.actionId)},
            ${
          draft.settlementScopeId
            ? param(draft.settlementScopeId)
            : `${source}.id`
        },
            ${source}.id, 'invoked', ${delivery}, ${
          param(draft.actionScopeId ?? null)
        } FROM ${source}
          ON CONFLICT (namespace, action_run_id) DO NOTHING
        )`]
        : data.status === "deferred"
        ? [`deferred_action AS (
          UPDATE ${tables.open_actions} AS action
          SET state = 'deferred', owner_delivery_id = NULL, deferred_event_id = ${source}.id
          FROM ${source}
          WHERE action.namespace = ${namespace} AND action.action_run_id = ${runId}
        )`]
        : terminal
        ? [`closed_action AS (
          DELETE FROM ${tables.open_actions} AS action USING ${source}
          WHERE action.namespace = ${namespace} AND action.action_run_id = ${runId}
        )`]
        : [],
    report: `jsonb_build_object('owned', ${gate})`,
    resolve(report, inserted) {
      if (inserted) return;
      const value = typeof report === "string" ? JSON.parse(report) : report;
      if (!(value as { owned?: boolean } | undefined)?.owned) {
        throw new ActionOwnershipLost(data.actionRunId);
      }
    },
  };
}

/** Compose transactional checks without adding SQL round trips. */
export function combineActionStatements(
  statements: readonly EventStatement<void>[],
): EventStatement<void> {
  return {
    ctes: statements.flatMap((statement) => statement.ctes),
    gate: statements.map((statement) => `(${statement.gate})`).join(" AND "),
    effects: (source) =>
      statements.flatMap((statement) => statement.effects(source)),
    report: `jsonb_build_array(${
      statements.map((statement) => statement.report).join(", ")
    })`,
    resolve(report, inserted) {
      const values = typeof report === "string" ? JSON.parse(report) : report;
      statements.forEach((statement, index) =>
        statement.resolve(values?.[index], inserted)
      );
    },
  };
}
