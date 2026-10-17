/** Private takeover inventory, not recovery admission or a readiness certificate.
 * Every read/write uses the acquired boundary transaction. No worker grant,
 * receipt replay, lease expiry, or missing effect receipt proves replay safety. */
import { createActionLifecycleLoader } from "../actions/persistence.ts";
import {
  createCoreTableNames,
  quoteEventIdentifier,
} from "../events/schema.ts";
import type { SqlExecutor } from "../events/session.ts";
import { createEventStore } from "../events/store.ts";
import type { PluginRegistry } from "../plugins/registry.ts";
import { createOperationCatalogTables } from "../streams/catalog.ts";
import type {
  OwnerCaller,
  OwnerCommand,
  OwnerCommandHandler,
  OwnerProjectionHandler,
} from "./boundary.ts";
import { readOwnerEffectInventory } from "./effects.ts";
import { ownerTableNames } from "./schema.ts";

export const OWNER_RECONCILIATION_INVENTORY = "reconciliation.inventory";
export const OWNER_RECONCILIATION_CLASSIFY = "reconciliation.classify";
const kinds = [
  "delivery",
  "assignment",
  "action",
  "operation",
  "stream",
  "effect",
  "claim",
  "alarm",
  "blocker",
] as const;
export type OwnerReconciliationTarget = Readonly<{
  kind: typeof kinds[number];
  /** null is retained corruption evidence, never an invented namespace. */
  namespace: string | null;
  id: string;
}>;
export type OwnerReconciliationCursor = Readonly<{
  ownerId: string;
  epoch: number;
  after: OwnerReconciliationTarget;
}>;
export type OwnerReconciliationPage = Readonly<{
  epoch: number;
  items: readonly OwnerReconciliationTarget[];
  next: OwnerReconciliationCursor | null;
  /** Only this suffix was exhausted in this transaction. Re-scan from null
   * independently before any future readiness decision; pages are not a snapshot. */
  exhausted: boolean;
}>;
export type OwnerReconciliationClassification = Readonly<{
  target: OwnerReconciliationTarget;
  disposition: "blocked" | "unscheduled" | "terminal" | "current" | "absent";
  reason: string;
  retired: number;
}>;
function refuse(message = "Owner reconciliation control refused."): never {
  throw Object.assign(new Error(message), {
    code: "owner_reconciliation_refused",
  });
}
function text(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 1024) {
    throw new TypeError("Invalid reconciliation identity.");
  }
}
function object(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== [...keys].sort().join(",")
  ) {
    throw new TypeError("Invalid reconciliation fields.");
  }
  return value as Record<string, unknown>;
}
function target(value: unknown): OwnerReconciliationTarget {
  const data = object(value, ["kind", "namespace", "id"]);
  if (!kinds.includes(data.kind as typeof kinds[number])) {
    throw new TypeError("Invalid inventory kind.");
  }
  if (data.namespace !== null) text(data.namespace);
  text(data.id);
  return {
    kind: data.kind as typeof kinds[number],
    namespace: data.namespace as string | null,
    id: data.id,
  };
}
export function ownerReconciliationKey(
  ownerId: string,
  epoch: number,
  value: OwnerReconciliationTarget,
): string {
  return JSON.stringify([
    OWNER_RECONCILIATION_CLASSIFY,
    ownerId,
    epoch,
    value.kind,
    value.namespace,
    value.id,
  ]);
}
export function ownerReconciliationAlarm(
  ownerId: string,
  value: OwnerReconciliationTarget,
): string {
  return JSON.stringify([
    "reconciliation",
    ownerId,
    value.kind,
    value.namespace,
    value.id,
  ]);
}

export function createOwnerReconciliation(
  options: Readonly<{
    ownerId: string;
    schema: string;
    registry: PluginRegistry;
    maxBatch?: number;
    maxAssignments?: number;
    maxAlarms?: number;
    /** Schema-wide SQL-only host control authentication. No execution grant is sufficient. */
    authorizeControl(
      tx: SqlExecutor,
      caller: OwnerCaller,
      commandTime: string,
    ): boolean | Promise<boolean>;
    /** One bounded postcommit hint. Refusal leaves all durable blockers intact. */
    wake?(): void;
  }>,
): Readonly<{
  handlers: Readonly<Record<string, OwnerCommandHandler>>;
  projections: Readonly<Record<string, OwnerProjectionHandler>>;
  authorize(
    tx: SqlExecutor,
    caller: OwnerCaller,
    command: OwnerCommand,
    commandTime: string,
  ): Promise<void>;
}> {
  const { ownerId, schema, authorizeControl, wake } = options;
  text(ownerId);
  if (typeof authorizeControl !== "function") {
    throw new TypeError("Reconciliation control authentication is required.");
  }
  const maxBatch = options.maxBatch ?? 25;
  const maxAssignments = options.maxAssignments ?? 100;
  const maxAlarms = options.maxAlarms ?? 10_000;
  for (
    const [value, maximum] of [[maxBatch, 100], [maxAssignments, 1000], [
      maxAlarms,
      100_000,
    ]]
  ) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new TypeError("Invalid reconciliation bound.");
    }
  }
  const core = createCoreTableNames(schema);
  const catalog = createOperationCatalogTables(schema);
  const owner = ownerTableNames(schema);
  const assignments = `${quoteEventIdentifier(schema)}."owner_assignments"`;
  const actions = new Set(
    Object.values(options.registry.actions).map((a) => a.id),
  );
  const processors = new Set(
    Object.values(options.registry.processors).map((p) => p.id),
  );
  type Authorization = {
    epoch: number;
    kind: string;
    after: OwnerReconciliationTarget | null;
    selected?: OwnerReconciliationTarget;
  };
  const authorized = new WeakMap<SqlExecutor, Authorization>();
  const inventorySql =
    `SELECT 'delivery'::text AS kind,e.namespace,d.id FROM ${core.event_deliveries} d LEFT JOIN ${core.events} e ON e.id=d.event_id
    UNION ALL SELECT DISTINCT 'assignment',e.namespace,a.delivery_id FROM ${assignments} a LEFT JOIN ${core.event_deliveries} d ON d.id=a.delivery_id LEFT JOIN ${core.events} e ON e.id=d.event_id WHERE a.retired=FALSE
    UNION ALL SELECT 'action',namespace,action_run_id FROM ${core.open_actions}
    UNION ALL SELECT 'operation',namespace,operation_id FROM ${catalog.operations}
    UNION ALL SELECT 'stream',namespace,stream_id FROM ${catalog.operationStreams} WHERE state IN ('open','terminating')
    UNION ALL SELECT 'effect',intent->>'namespace',key FROM ${owner.receipts} WHERE kind LIKE 'effect.%' OR left(key,10)='["effect",'
    UNION ALL SELECT 'claim',NULL::text,r.key FROM ${owner.receipts} r LEFT JOIN ${core.event_deliveries} d ON d.id=r.result->>'deliveryId' WHERE r.kind IN ('execution.claim','processor.claim') AND d.id IS NULL
    UNION ALL SELECT CASE WHEN left(name,18)='["reconciliation",' THEN 'blocker' ELSE 'alarm' END,NULL::text,name FROM ${owner.alarms}`;
  // LIMIT bounds retained data, not database query-plan work. Large-history
  // indexed scan/performance proof is a separate requirement.
  async function inventory(
    tx: SqlExecutor,
    state: Authorization,
  ): Promise<OwnerReconciliationPage> {
    const after = state.after;
    const rows = await tx.query<
      { kind: string; namespace: string | null; id: string }
    >(
      `SELECT kind,namespace,id FROM (${inventorySql}) candidates
       WHERE $1::text IS NULL OR (kind,COALESCE(namespace,''),id)>($1,$2,$3)
       ORDER BY kind,COALESCE(namespace,''),id LIMIT $4`,
      [
        after?.kind ?? null,
        after?.namespace ?? "",
        after?.id ?? "",
        maxBatch + 1,
      ],
    );
    const items = rows.rows.slice(0, maxBatch).map(target);
    const exhausted = rows.rows.length <= maxBatch;
    return {
      epoch: state.epoch,
      items,
      exhausted,
      next: exhausted ? null : {
        ownerId: ownerId,
        epoch: state.epoch,
        after: items[items.length - 1],
      },
    };
  }
  function consume(tx: SqlExecutor, kind: string): Authorization {
    const state = authorized.get(tx);
    authorized.delete(tx);
    if (!state || state.kind !== kind) return refuse();
    return state;
  }
  type AssignmentRow = {
    owner: string;
    epoch: number | string;
    session_id: string;
    assignment_id: string;
    binding: Record<string, unknown>;
    retired: boolean;
  };
  async function classifyDelivery(
    tx: SqlExecutor,
    selected: OwnerReconciliationTarget,
    epoch: number,
    time: string,
  ): Promise<OwnerReconciliationClassification> {
    const result = (
      disposition: OwnerReconciliationClassification["disposition"],
      reason: string,
      retired = 0,
    ): OwnerReconciliationClassification => ({
      target: selected,
      disposition,
      reason,
      retired,
    });
    const store = createEventStore({
      schema: schema,
      session: {
        query: tx.query.bind(tx),
        transaction() {
          throw new TypeError("Inventory cannot open transactions.");
        },
      },
    });
    const delivery = await store.getDelivery(selected.id);
    if (!delivery) return result("blocked", "assignment_without_delivery");
    const source = await store.getEvent(delivery.eventId);
    if (
      !source || source.namespace !== selected.namespace ||
      source.ownerId !== ownerId
    ) return result("blocked", "source_identity_mismatch");
    // Preserve normal operation -> delivery lock order. The boundary serializes
    // owner commands; these checks still bind every transition to current rows.
    const scope = (await tx.query<
      {
        root_owner: string | null;
        root_namespace: string | null;
        state: string;
      }
    >(
      `SELECT root.owner_id AS root_owner,root.namespace AS root_namespace,o.state FROM ${catalog.operations} o LEFT JOIN ${core.events} root ON root.id=o.root_event_id WHERE o.namespace=$1 AND o.operation_id=$2 FOR UPDATE OF o`,
      [source.namespace, delivery.settlementScopeId],
    )).rows[0];
    await tx.query(
      `SELECT id FROM ${core.event_deliveries} WHERE id=$1 FOR UPDATE`,
      [delivery.id],
    );
    if (
      !scope || scope.root_owner !== ownerId ||
      scope.root_namespace !== source.namespace
    ) return result("blocked", "scope_identity_mismatch");
    const rows = (await tx.query<AssignmentRow>(
      `SELECT owner,epoch,session_id,assignment_id,CASE WHEN octet_length(binding::text)<=16384 THEN binding ELSE '{}'::jsonb END AS binding,retired FROM ${assignments} WHERE delivery_id=$1 ORDER BY epoch,session_id,assignment_id LIMIT $2 FOR UPDATE`,
      [delivery.id, maxAssignments + 1],
    )).rows;
    if (rows.length > maxAssignments) {
      return result("blocked", "assignment_inventory_incomplete");
    }
    const processor = delivery.consumerId.startsWith("processor:");
    const actionId = source.metadata.actionId;
    const runId = source.metadata.actionRunId;
    if (
      processor
        ? !processors.has(delivery.consumerId.slice(10))
        : typeof actionId !== "string" || typeof runId !== "string" ||
          !actions.has(actionId) ||
          delivery.consumerId !== `registered:${actionId}`
    ) {
      return result("blocked", "unsupported_consumer_or_source");
    }
    for (const row of rows) {
      const b = row.binding;
      const fields = [
        "workerId",
        "workerAttemptId",
        "sessionGeneration",
        "sessionId",
        "parentOperationId",
        "assignmentId",
        "dispatchAttemptId",
        "namespace",
        "sourceEventId",
        "deliveryId",
        ...(processor ? ["kind", "processorId"] : ["actionId", "executionId"]),
      ];
      const exact = b && typeof b === "object" && !Array.isArray(b) &&
        Object.keys(b).sort().join(",") === fields.sort().join(",") &&
        fields.every((key) =>
          key === "sessionGeneration"
            ? Number.isSafeInteger(b[key]) && Number(b[key]) >= 0
            : typeof b[key] === "string" && !!(b[key] as string).trim() &&
              (b[key] as string).length <= 1024
        );
      if (
        !exact ||
        row.owner !== ownerId ||
        !Number.isSafeInteger(Number(row.epoch)) || Number(row.epoch) <= 0 ||
        !b ||
        b.namespace !== source.namespace || b.deliveryId !== delivery.id ||
        b.sourceEventId !== source.id || b.assignmentId !== row.assignment_id ||
        b.sessionId !== row.session_id ||
        typeof b.dispatchAttemptId !== "string" || !b.dispatchAttemptId ||
        (processor
          ? b.kind !== "processor" ||
            b.processorId !== delivery.consumerId.slice(10)
          : b.kind !== undefined || b.actionId !== actionId ||
            b.executionId !== runId)
      ) {
        return result("blocked", "assignment_identity_mismatch");
      }
      if (Number(row.epoch) > epoch) {
        return result("blocked", "future_epoch_binding");
      }
      if (Number(row.epoch) === epoch && !row.retired) {
        return result("current", "current_epoch_binding");
      }
    }
    const open = (await tx.query(
      `SELECT 1 FROM ${core.open_actions} WHERE namespace=$1 AND (owner_delivery_id=$2 OR action_run_id=$3) LIMIT 1`,
      [source.namespace, delivery.id, processor ? null : runId],
    )).rows.length > 0;
    const claims = (await tx.query(
      `SELECT 1 FROM ${owner.receipts} WHERE owner=$1 AND kind IN ('execution.claim','processor.claim') AND result->>'deliveryId'=$2 LIMIT 1`,
      [ownerId, delivery.id],
    )).rows.length > 0;
    let terminal = false;
    let invoked = false;
    let effects = false;
    if (!processor) {
      const executionId = runId as string;
      invoked = !!await store.getEventByDeduplicationId(
        source.namespace,
        `${executionId}:action:invoked`,
      );
      const event = await store.getEventByDeduplicationId(
        source.namespace,
        `${executionId}:action:terminal`,
      );
      if (event) {
        const status = event.metadata.actionStatus;
        if (
          event.ownerId !== ownerId ||
          event.causationId !== source.id ||
          event.metadata.sourceDeliveryId !== delivery.id ||
          event.metadata.actionId !== actionId ||
          event.subject?.id !== executionId ||
          event.subject.type !== actionId ||
          event.type !== `${actionId}.${status}` ||
          !["completed", "failed", "cancelled"].includes(String(status))
        ) {
          return result("blocked", "terminal_identity_mismatch");
        }
        try {
          const lifecycle = await createActionLifecycleLoader({ store })(
            source.namespace,
            `${executionId}:action:terminal`,
          );
          terminal = !!lifecycle && lifecycle.actionId === actionId &&
            lifecycle.actionRunId === executionId &&
            lifecycle.status === status &&
            ({
                completed: "succeeded",
                failed: "dead_letter",
                cancelled: "cancelled",
              } as Record<string, string>)[String(status)] ===
              delivery.status &&
            !open;
        } catch {
          return result("blocked", "unsupported_terminal_body");
        }
      }
      try {
        effects = (await readOwnerEffectInventory(tx, {
          ownerId: ownerId,
          schema: schema,
          namespace: source.namespace,
          actionRunId: executionId,
        })).length > 0;
      } catch {
        return result("blocked", "effect_inventory_invalid");
      }
    }
    const neverClaimed = delivery.status === "pending" &&
      delivery.attempts === 0 && delivery.leaseOwner === undefined &&
      delivery.leaseExpiresAt === undefined && !claims &&
      !open && !invoked && !effects && !terminal;
    // Processor terminal delivery is durable settlement evidence, but it does
    // not make any lost pending/leased attempt replayable.
    const settledProcessor = processor &&
      ["succeeded", "cancelled", "dead_letter"].includes(delivery.status) &&
      !open;
    if (!neverClaimed && !terminal && !settledProcessor) {
      return result(
        "blocked",
        rows.length === 0 &&
          (delivery.attempts > 0 || delivery.status === "leased")
          ? "claimed_without_binding"
          : processor
          ? "processor_recovery_required"
          : "action_recovery_required",
      );
    }
    if (neverClaimed && !["accepted", "running"].includes(scope.state)) {
      return result("blocked", "pending_in_terminal_scope");
    }
    let retired = 0;
    for (const row of rows) {
      if (row.retired) continue;
      // Exact prior epoch and immutable binding equality; never retire current.
      const changed = await tx.query(
        `UPDATE ${assignments} SET retired=TRUE,retired_at=$1::timestamptz WHERE owner=$2 AND epoch=$3 AND epoch<$4 AND session_id=$5 AND assignment_id=$6 AND delivery_id=$7 AND binding=$8::jsonb AND retired=FALSE RETURNING assignment_id`,
        [
          time,
          ownerId,
          Number(row.epoch),
          epoch,
          row.session_id,
          row.assignment_id,
          delivery.id,
          JSON.stringify(row.binding),
        ],
      );
      if (changed.rows.length !== 1) {
        return refuse("Prior reservation changed during classification.");
      }
      retired++;
    }
    return result(
      neverClaimed ? "unscheduled" : "terminal",
      neverClaimed ? "never_claimed" : "settled",
      retired,
    );
  }
  async function classify(
    tx: SqlExecutor,
    selected: OwnerReconciliationTarget,
    epoch: number,
    time: string,
  ): Promise<OwnerReconciliationClassification> {
    if (selected.kind === "delivery" || selected.kind === "assignment") {
      return await classifyDelivery(tx, selected, epoch, time);
    }
    const block = (reason: string): OwnerReconciliationClassification => ({
      target: selected,
      disposition: "blocked",
      reason,
      retired: 0,
    });
    if (selected.kind === "action") {
      return block("open_action_recovery_required");
    }
    if (selected.kind === "stream") return block("stream_recovery_unsupported");
    if (selected.kind === "effect") {
      return block("effect_reconciliation_required");
    }
    if (selected.kind === "claim") return block("claim_without_delivery");
    if (selected.kind === "blocker") {
      return block("retained_reconciliation_obligation");
    }
    if (selected.kind === "alarm") return block("alarm_rescheduling_required");
    const current = (await tx.query<
      {
        owner_id: string;
        root_namespace: string;
        state: string;
        pending: boolean;
      }
    >(
      `SELECT e.owner_id,e.namespace AS root_namespace,o.state,
      EXISTS(SELECT 1 FROM ${core.open_actions} a WHERE a.namespace=o.namespace AND a.scope_id=o.operation_id) OR
      EXISTS(SELECT 1 FROM ${core.event_deliveries} d JOIN ${core.events} source ON source.id=d.event_id WHERE source.namespace=o.namespace AND d.settlement_scope_id=o.operation_id AND d.status IN ('pending','leased','retry_wait')) OR
      EXISTS(SELECT 1 FROM ${catalog.operationStreams} s WHERE s.namespace=o.namespace AND s.operation_id=o.operation_id AND s.state IN ('open','terminating')) AS pending
      FROM ${catalog.operations} o LEFT JOIN ${core.events} e ON e.id=o.root_event_id WHERE o.namespace=$1 AND o.operation_id=$2 FOR UPDATE OF o`,
      [selected.namespace, selected.id],
    )).rows[0];
    if (!current) return block("operation_missing");
    if (
      current.owner_id !== ownerId ||
      current.root_namespace !== selected.namespace
    ) return block("operation_root_mismatch");
    if (current.pending || ["accepted", "running"].includes(current.state)) {
      return block("operation_settlement_required");
    }
    return {
      target: selected,
      disposition: "terminal",
      reason: "settled_scope",
      retired: 0,
    };
  }
  const projection: OwnerProjectionHandler = (_input, context) =>
    inventory(context.tx, consume(context.tx, OWNER_RECONCILIATION_INVENTORY));
  const handler: OwnerCommandHandler = async (_input, context) => {
    const state = consume(context.tx, OWNER_RECONCILIATION_CLASSIFY);
    if (!state.selected || context.ownerCommit.epoch !== state.epoch) {
      return refuse();
    }
    const selected = state.selected;
    const present = await context.tx.query(
      `SELECT 1 FROM (${inventorySql}) candidates WHERE kind=$1 AND namespace IS NOT DISTINCT FROM $2::text AND id=$3 LIMIT 1`,
      [selected.kind, selected.namespace, selected.id],
    );
    if (!present.rows.length) {
      return {
        target: selected,
        disposition: "absent",
        reason: "target_no_longer_present",
        retired: 0,
      };
    }
    const result = await classify(
      context.tx,
      selected,
      state.epoch,
      context.commandTime,
    );
    // Every classified target retains a discovery obligation, even when its
    // reservation is safely retired. Only a future independent exhaustive
    // recovery proof may clear these alarms. Historical receipts cannot do so.
    if (selected.kind === "blocker") return result;
    const name = ownerReconciliationAlarm(ownerId, selected);
    const count = await context.tx.query(
      `SELECT 1 FROM ${owner.alarms} WHERE owner=$1 AND name<>$2 LIMIT $3`,
      [ownerId, name, maxAlarms],
    );
    if (count.rows.length >= maxAlarms) {
      return refuse(
        "Reconciliation alarm capacity reached; inventory remains incomplete.",
      );
    }
    await context.tx.query(
      `INSERT INTO ${owner.alarms}(owner,name,due_at) VALUES($1,$2,$3::timestamptz) ON CONFLICT(owner,name) DO NOTHING`,
      [ownerId, name, context.commandTime],
    );
    if (wake) {
      context.afterCommit(() => {
        wake();
      });
    }
    return result;
  };
  return {
    handlers: { [OWNER_RECONCILIATION_CLASSIFY]: handler },
    projections: { [OWNER_RECONCILIATION_INVENTORY]: projection },
    async authorize(tx, caller, command, commandTime) {
      authorized.delete(tx);
      if (caller.principal.kind !== "owner-control") return refuse();
      const epoch = caller.ownerEpoch;
      if (!Number.isSafeInteger(epoch) || epoch < 1) return refuse();
      let after: OwnerReconciliationTarget | null = null;
      let selected: OwnerReconciliationTarget | undefined;
      if (command.kind === OWNER_RECONCILIATION_INVENTORY) {
        const data = object(command.intent, ["cursor"]);
        if (data.cursor !== null) {
          const cursor = object(data.cursor, ["ownerId", "epoch", "after"]);
          if (cursor.ownerId !== ownerId || cursor.epoch !== epoch) {
            return refuse("Inventory cursor belongs to another owner epoch.");
          }
          after = target(cursor.after);
        }
      } else if (command.kind === OWNER_RECONCILIATION_CLASSIFY) {
        selected = target(command.intent);
        if (
          command.domain !== "occurrence" ||
          command.key !==
            ownerReconciliationKey(ownerId, epoch, selected)
        ) throw new TypeError("Invalid classification command identity.");
      } else throw new TypeError("Unknown reconciliation command.");
      if (
        await authorizeControl(tx, structuredClone(caller), commandTime) !==
          true
      ) {
        return refuse();
      }
      authorized.set(tx, {
        epoch,
        kind: command.kind,
        after,
        ...(selected ? { selected } : {}),
      });
    },
  };
}
