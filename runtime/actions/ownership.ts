import {
  type CoreTableName,
  createCoreTableNames,
  quoteEventIdentifier,
} from "../events/schema.ts";
import type {
  EventStatement,
  OwnerEventCommitContext,
} from "../events/store.ts";
import type { ActionLifecycleAppendInput } from "./types.ts";

/** Execution authority is transient; retry receipts keep their original bytes. */
export type ActionWriter =
  | Readonly<{ kind: "delivery"; deliveryId: string; leaseOwner: string }>
  | Readonly<{ kind: "owner-attempt"; deliveryId: string; attemptId: string }>
  | Readonly<{ kind: "recovery"; deliveryId: string }>
  | Readonly<{ kind: "cancellation"; namespace: string; operationId: string }>;

/** Internal command authority, never inferred from a delivery's NULL deadline. */
export type OwnerActionAuthority = Readonly<{
  authority: OwnerEventCommitContext;
  schema: string;
}>;

/** Validate both the supplied store and the insertion's actual table binding. */
export function validateOwnerActionAuthority(
  writer: Extract<ActionWriter, { kind: "owner-attempt" }>,
  owner: OwnerActionAuthority | undefined,
  tables: Readonly<Record<CoreTableName, string>>,
): asserts owner is OwnerActionAuthority {
  const authority = owner?.authority;
  const attempt = authority?.ownerAttempt;
  if (
    !owner || !authority || !attempt ||
    !Number.isSafeInteger(authority.epoch) || authority.epoch < 1 ||
    [authority.ownerId, authority.holderId, writer.deliveryId, writer.attemptId]
      .some((value) =>
        typeof value !== "string" || !value.trim() || value !== value.trim() ||
        value.length > 1024
      ) ||
    attempt.deliveryId !== writer.deliveryId ||
    attempt.attemptId !== writer.attemptId
  ) throw new TypeError("Invalid owner-controlled Action authority.");
  if (
    typeof authority.commandTime !== "string" ||
    !Number.isFinite(Date.parse(authority.commandTime))
  ) {
    throw new TypeError(
      "Owner-controlled Action commandTime must be a valid timestamp.",
    );
  }
  if (typeof owner.schema !== "string") {
    throw new TypeError("Owner-controlled Actions require an explicit schema.");
  }
  const expected = createCoreTableNames(owner.schema);
  if (
    (Object.keys(expected) as CoreTableName[]).some((name) =>
      tables[name] !== expected[name]
    )
  ) {
    throw new TypeError(
      "Owner-controlled Action schema must match the Event Store.",
    );
  }
}

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
  /** Trusted boundary-captured clock, never a worker-supplied value. */
  commandTime?: string,
  attemptOwner?: OwnerActionAuthority,
): EventStatement<void> {
  if (writer?.kind === "owner-attempt") {
    validateOwnerActionAuthority(writer, attemptOwner, tables);
  }
  if (
    commandTime !== undefined &&
    (typeof commandTime !== "string" ||
      !Number.isFinite(Date.parse(commandTime)))
  ) {
    throw new TypeError("Action commandTime must be a valid timestamp.");
  }
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
  if (writer.kind === "owner-attempt") {
    const { authority, schema } = attemptOwner!;
    // Take the epoch lock before the delivery lock. A NULL lease is only the
    // representation of owner-controlled liveness; this exact command grants authority.
    ctes.push(`action_owner_epoch AS MATERIALIZED (
      SELECT owner FROM ${quoteEventIdentifier(schema)}."owner_epochs"
      WHERE owner = ${param(authority.ownerId)} AND epoch = ${
      param(authority.epoch)
    } AND holder = ${param(authority.holderId)}
      FOR UPDATE
    )`);
  }
  if (writer && writer.kind !== "cancellation") {
    ctes.push(`action_writer AS MATERIALIZED (
      SELECT id FROM ${tables.event_deliveries}
      WHERE id = ${delivery} AND EXISTS (SELECT 1 FROM event_admission) AND ${
      writer.kind === "delivery"
        ? `status = 'leased' AND lease_owner = ${
          param(writer.leaseOwner)
        } AND lease_expires_at > ${
          commandTime === undefined
            ? "NOW()"
            : `${param(commandTime)}::timestamptz`
        }`
        : writer.kind === "owner-attempt"
        ? `status = 'leased' AND lease_owner = ${param(writer.attemptId)}
          AND lease_expires_at IS NULL
          AND EXISTS (SELECT 1 FROM action_owner_epoch)`
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
