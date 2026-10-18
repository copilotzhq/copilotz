import type { ActionRecoveryCatalog } from "../actions/recovery.ts";
/** Private startup-only terminal cleanup for an explicit finite Action inventory.
 * This seam never requeues, dispatches, grants execution, or certifies readiness. */
import { actionDefinitionHasSecrets } from "../actions/protected-lifecycle.ts";
import { createCoreTableNames } from "../events/schema.ts";
import type { SqlExecutor, SqlSession } from "../events/session.ts";
import type { DeliveryExecutor } from "../execution/types.ts";
import type { PluginRegistry } from "../plugins/registry.ts";
import {
  createOperationCatalogTables,
  type OperationCatalogCore,
  type OperationSettlementScope,
} from "../streams/catalog.ts";
import type {
  OwnerCaller,
  OwnerCommand,
  OwnerCommandBoundary,
  OwnerCommandContext,
  OwnerCommandHandler,
  OwnerJson,
  OwnerProjectionHandler,
} from "../owner/boundary.ts";
import {
  createOwnerLostActionRecovery,
  OWNER_LOST_ACTION_RECOVERY,
  ownerLostActionKey,
  type OwnerLostActionResult,
} from "../owner/lost-action.ts";
import { OWNER_PREPARATION_METADATA } from "../owner/preparation-capture.ts";

export type OwnerHostTerminalRecoveryTarget = Readonly<{
  namespace: string;
  deliveryId: string;
}>;
type Owner = Readonly<{ ownerId: string; epoch: number; holderId: string }>;
export type OwnerHostTerminalRecoveryFacts = Readonly<{
  phase: "startup-terminal";
  owner: Owner;
  target: OwnerHostTerminalRecoveryTarget;
  disposition: "exhausted" | "cancelled";
  current: Readonly<{
    sourceEventId: string;
    actionId: string;
    actionRunId: string;
    attempts: number;
    maxAttempts: number;
    leaseOwner: string;
    leaseExpiresAt: string | null;
    cancellationRequestedAt: string | null;
  }>;
}>;
export type OwnerHostTerminalRecoveryOptions = Readonly<{
  targets: readonly OwnerHostTerminalRecoveryTarget[];
  /** SQL-only current owner policy. Detached facts grant no historical rights. */
  authorizeTerminal(
    tx: SqlExecutor,
    facts: OwnerHostTerminalRecoveryFacts,
    commandTime: string,
  ): boolean | Promise<boolean>;
}>;
function refuse(message = "Private startup terminal recovery refused."): never {
  throw Object.assign(new Error(message), {
    code: "owner_host_terminal_recovery_refused",
  });
}
function text(value: unknown): asserts value is string {
  if (
    typeof value !== "string" || !value.trim() || value !== value.trim() ||
    value.length > 1024
  ) throw new TypeError("Invalid terminal recovery identity.");
}
function own(value: unknown, fields: readonly string[]) {
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) throw new TypeError("Terminal recovery needs closed own-data objects.");
  const result: Record<string, unknown> = {};
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length) {
    throw new TypeError("Invalid terminal recovery fields.");
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" || !fields.includes(key) ||
      !descriptor?.enumerable || !("value" in descriptor)
    ) throw new TypeError("Terminal recovery fields must be own data.");
    result[key] = descriptor.value;
  }
  return result;
}
const targetKey = (target: OwnerHostTerminalRecoveryTarget) =>
  JSON.stringify([target.namespace, target.deliveryId]);
/** Synchronous capture, before any host initialization/provisioning await. */
export function captureOwnerHostTerminalRecovery(
  supplied: OwnerHostTerminalRecoveryOptions,
) {
  const input = own(supplied, ["targets", "authorizeTerminal"]);
  const values = input.targets;
  if (
    !Array.isArray(values) ||
    Object.getPrototypeOf(values) !== Array.prototype ||
    values.length < 1 || values.length > 100 ||
    Reflect.ownKeys(values).length !== values.length + 1 ||
    typeof input.authorizeTerminal !== "function"
  ) throw new TypeError("Invalid finite terminal recovery inventory.");
  const targets: OwnerHostTerminalRecoveryTarget[] = [];
  const keys = new Set<string>();
  for (let index = 0; index < values.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(values, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError("Terminal targets must be dense own data.");
    }
    const target = own(descriptor.value, ["namespace", "deliveryId"]);
    text(target.namespace);
    text(target.deliveryId);
    const captured = {
      namespace: target.namespace,
      deliveryId: target.deliveryId,
    };
    if (keys.has(targetKey(captured))) {
      throw new TypeError("Duplicate terminal recovery target.");
    }
    keys.add(targetKey(captured));
    targets.push(captured);
  }
  return {
    targets,
    authorizeTerminal: input
      .authorizeTerminal as OwnerHostTerminalRecoveryOptions[
        "authorizeTerminal"
      ],
  };
}
export function createOwnerHostTerminalRecovery(
  options: Readonly<{
    configuration: ReturnType<typeof captureOwnerHostTerminalRecovery>;
    ownerId: string;
    schema: string;
    session: SqlSession;
    registry: PluginRegistry;
    catalog: OperationCatalogCore & ActionRecoveryCatalog;
    executor: DeliveryExecutor;
    /** Present only for this exact acquired, unready, transport-absent owner. */
    currentOwner(): Owner | undefined;
    scheduleSettlement(
      context: OwnerCommandContext,
      scope: OperationSettlementScope,
    ): void | Promise<void>;
  }>,
) {
  const { configuration, ownerId, schema, currentOwner } = options;
  const core = createCoreTableNames(schema);
  const operations = createOperationCatalogTables(schema);
  const actionIds = new Map<string, number>();
  for (const action of Object.values(options.registry.actions)) {
    if (
      action.content || action.resolve || actionDefinitionHasSecrets(action)
    ) {
      continue;
    }
    actionIds.set(action.id, (actionIds.get(action.id) ?? 0) + 1);
  }
  const selected = new Map(configuration.targets.map((target) => [
    targetKey(target),
    target,
  ]));
  const attempted = new Set<string>();
  type Token = Readonly<{
    purpose: "startup-terminal-action";
    owner: Owner;
    target: OwnerHostTerminalRecoveryTarget;
    occurrence: string;
    key: string;
  }>;
  const tokens = new Map<string, Token>();
  function current(
    caller: OwnerCaller,
    target: OwnerHostTerminalRecoveryTarget,
  ) {
    const record = typeof caller.hostControl === "string"
      ? tokens.get(caller.hostControl)
      : undefined;
    const owner = currentOwner();
    if (
      !record || !owner || record.purpose !== "startup-terminal-action" ||
      owner.ownerId !== ownerId ||
      owner.epoch !== record.owner.epoch ||
      owner.holderId !== record.owner.holderId ||
      caller.principal.kind !== "owner-control" ||
      caller.principal.ownerId !== owner.ownerId ||
      caller.principal.epoch !== owner.epoch ||
      caller.principal.holderId !== owner.holderId ||
      caller.ownerEpoch !== owner.epoch ||
      targetKey(target) !== targetKey(record.target)
    ) refuse();
    return record;
  }
  async function readTarget(
    tx: SqlExecutor,
    target: OwnerHostTerminalRecoveryTarget,
  ) {
    const rows = (await tx.query<Record<string, unknown>>(
      `SELECT
        CASE WHEN octet_length(d.event_id)<=1024 THEN d.event_id END AS source_event_id,
        CASE WHEN octet_length(d.settlement_scope_id)<=1024 THEN d.settlement_scope_id END AS scope_id,
        CASE WHEN octet_length(o.root_event_id)<=1024 THEN o.root_event_id END AS root_event_id,
        CASE WHEN octet_length(e.correlation_id)<=1024 THEN e.correlation_id END AS correlation_id,
        CASE WHEN octet_length(invoked.id)<=1024 THEN invoked.id END AS invoked_event_id,
        CASE WHEN octet_length(e.metadata->>'actionId')<=1024 THEN e.metadata->>'actionId' END AS action_id,
        CASE WHEN octet_length(e.metadata->>'actionRunId')<=1024 THEN e.metadata->>'actionRunId' END AS action_run_id,
        (e.owner_id=$2 AND e.namespace=$3 AND e.type='copilotz.owner.action.requested'
          AND e.deduplication_id=e.metadata->>'actionRunId'
          AND d.consumer_id='registered:'||(e.metadata->>'actionId')) AS identity_matches,
        (root.owner_id=$2 AND root.namespace=$3) AS root_matches,
        (o.state IN ('accepted','running')) AS scope_live,
        (d.action_scope_id IS NULL AND NOT EXISTS(SELECT 1 FROM ${core.open_actions} a
          WHERE a.owner_delivery_id=d.id AND a.action_scope_id IS NOT NULL)) AS scopes_supported,
        (NOT (e.metadata ? $4) AND NOT EXISTS(SELECT 1 FROM ${core.events} invoked
          WHERE invoked.namespace=$3 AND invoked.deduplication_id=(e.metadata->>'actionRunId')||':action:invoked'
          AND invoked.metadata ? $4)) AS preparation_absent,
        CASE WHEN d.status IN ('leased','succeeded','dead_letter','cancelled') THEN d.status END AS status,
        d.attempts,d.max_attempts,
        CASE WHEN octet_length(d.lease_owner)<=1024 THEN d.lease_owner END AS lease_owner,
        (d.lease_owner IS NULL) AS lease_owner_null,
        CASE WHEN isfinite(d.lease_expires_at) THEN d.lease_expires_at::text END AS lease_expires_at,
        (d.lease_expires_at IS NULL OR isfinite(d.lease_expires_at)) AS lease_deadline_valid,
        o.cancellation_requested_at::text AS cancellation_requested_at,
        (o.cancellation_requested_at IS NULL OR isfinite(o.cancellation_requested_at)) AS cancellation_valid
       FROM ${core.event_deliveries} d
       LEFT JOIN ${core.events} e ON e.id=d.event_id
       LEFT JOIN ${operations.operations} o ON o.namespace=$3 AND o.operation_id=d.settlement_scope_id
       LEFT JOIN ${core.events} root ON root.id=o.root_event_id
       LEFT JOIN ${core.events} invoked ON invoked.namespace=$3 AND invoked.deduplication_id=(e.metadata->>'actionRunId')||':action:invoked'
       WHERE d.id=$1 LIMIT 2`,
      [
        target.deliveryId,
        ownerId,
        target.namespace,
        OWNER_PREPARATION_METADATA,
      ],
    )).rows;
    if (rows.length !== 1) refuse("Configured terminal target is missing.");
    const row = rows[0];
    for (
      const key of [
        "source_event_id",
        "scope_id",
        "root_event_id",
        "correlation_id",
        "invoked_event_id",
        "action_id",
        "action_run_id",
      ]
    ) text(row[key]);
    if (
      row.identity_matches !== true || row.root_matches !== true ||
      row.scopes_supported !== true || row.preparation_absent !== true ||
      row.cancellation_valid !== true ||
      actionIds.get(row.action_id as string) !== 1 ||
      !Number.isSafeInteger(row.attempts) || Number(row.attempts) < 1 ||
      !Number.isSafeInteger(row.max_attempts) || Number(row.max_attempts) < 1
    ) refuse("Configured terminal target is unsupported or mismatched.");
    if (
      typeof row.status === "string" &&
      ["succeeded", "dead_letter", "cancelled"].includes(row.status)
    ) {
      if (
        row.lease_owner_null !== true || row.lease_expires_at !== null ||
        row.lease_deadline_valid !== true
      ) {
        refuse("Terminal target retains a lease.");
      }
      // This candidate stays unaccounted until the wrapped exhaustive proof
      // succeeds in the same transaction. Status alone is never closure proof.
      return { kind: "terminal-candidate" as const, row };
    }
    if (
      row.status !== "leased" || row.scope_live !== true ||
      row.lease_deadline_valid !== true
    ) {
      refuse("Configured target is not a supported lost worker attempt.");
    }
    text(row.lease_owner);
    if (row.lease_expires_at !== null) text(row.lease_expires_at);
    if (row.cancellation_requested_at !== null) {
      text(row.cancellation_requested_at);
    }
    return { kind: "lost" as const, row };
  }
  const recovery = createOwnerLostActionRecovery({
    ownerId,
    schema,
    session: options.session,
    registry: options.registry,
    catalog: options.catalog,
    executor: options.executor,
    scheduleSettlement: options.scheduleSettlement,
    authorizeRecoveryTransition: () => false,
    async authorizeControl(tx, caller, target, commandTime) {
      const record = current(caller, target);
      const before = await readTarget(tx, target);
      if (before.kind !== "lost") refuse();
      const row = before.row;
      const cancelled = row.cancellation_requested_at !== null;
      if (!cancelled && Number(row.attempts) < Number(row.max_attempts)) {
        refuse("Terminal recovery cannot retry a budgeted Action.");
      }
      const facts: OwnerHostTerminalRecoveryFacts = {
        phase: "startup-terminal",
        owner: record.owner,
        target: record.target,
        disposition: cancelled ? "cancelled" : "exhausted",
        current: {
          sourceEventId: row.source_event_id as string,
          actionId: row.action_id as string,
          actionRunId: row.action_run_id as string,
          attempts: Number(row.attempts),
          maxAttempts: Number(row.max_attempts),
          leaseOwner: row.lease_owner as string,
          leaseExpiresAt: row.lease_expires_at as string | null,
          cancellationRequestedAt: row.cancellation_requested_at as
            | string
            | null,
        },
      };
      if (
        await configuration.authorizeTerminal(
          tx,
          structuredClone(facts),
          commandTime,
        ) !== true
      ) {
        refuse("Current terminal recovery policy refused.");
      }
      const after = await readTarget(tx, target);
      if (
        current(caller, target) !== record ||
        JSON.stringify(after) !== JSON.stringify(before)
      ) {
        refuse("Terminal recovery authority or current facts changed.");
      }
      return true;
    },
  });
  return {
    handlers: recovery.handlers,
    async authorize(
      tx: SqlExecutor,
      caller: OwnerCaller,
      command: OwnerCommand,
      time: string,
    ) {
      const intent = command.intent as Record<string, unknown> | null;
      const record = current(caller, {
        namespace: typeof intent?.namespace === "string"
          ? intent.namespace
          : "",
        deliveryId: typeof intent?.deliveryId === "string"
          ? intent.deliveryId
          : "",
      });
      if (
        command.kind !== OWNER_LOST_ACTION_RECOVERY ||
        command.domain !== "occurrence" || command.key !== record.key ||
        intent?.occurrence !== record.occurrence
      ) refuse();
      await recovery.authorize(tx, caller, command, time);
    },
    wrapRepair(handler: OwnerCommandHandler): OwnerCommandHandler {
      return async (input, context) => {
        const result = await handler(input, context);
        if (!result || typeof result !== "object" || Array.isArray(result)) {
          refuse();
        }
        const plan = result as Readonly<Record<string, OwnerJson>>;
        if (!Array.isArray(plan.blockers)) refuse();
        const blockers = plan.blockers as Array<
          { kind: string; namespace: string | null; id: string; reason: string }
        >;
        const terminalTargets: OwnerHostTerminalRecoveryTarget[] = [];
        for (const target of configuration.targets) {
          const observed = await readTarget(context.tx, target);
          if (observed.kind === "lost") {
            // Extra format denial from this actual current repair scan. Its
            // first diagnostic per target is not a complete provenance proof;
            // the lost helper still independently validates every transition.
            if (
              !blockers.some((blocker) =>
                blocker.kind === "delivery" &&
                blocker.namespace === target.namespace &&
                blocker.id === target.deliveryId &&
                blocker.reason === "execution_recovery_required"
              )
            ) refuse("Selected delivery has incompatible startup format.");
            const events = [
              observed.row.source_event_id,
              observed.row.root_event_id,
              observed.row.invoked_event_id,
            ];
            if (
              blockers.some((blocker) =>
                blocker.kind === "operation" &&
                blocker.namespace === target.namespace &&
                events.includes(blocker.id) &&
                !(blocker.id === observed.row.scope_id &&
                  blocker.reason === "operation_has_unresolved_obligations")
              )
            ) refuse("Selected lifecycle has incompatible startup format.");
            terminalTargets.push({ ...target });
          }
        }
        return { ...plan, terminalTargets };
      };
    },
    wrapProof(handler: OwnerProjectionHandler): OwnerProjectionHandler {
      return async (input, context) => {
        const result = await handler(input, context);
        for (const target of configuration.targets) {
          if (
            (await readTarget(context.tx, target)).kind !== "terminal-candidate"
          ) refuse("Configured target remains unaccounted.");
        }
        return result;
      };
    },
    async recover(
      boundary: OwnerCommandBoundary,
      target: OwnerHostTerminalRecoveryTarget,
    ) {
      const captured = selected.get(targetKey(target));
      const owner = currentOwner();
      if (!captured || !owner || attempted.has(targetKey(captured))) refuse();
      attempted.add(targetKey(captured));
      const occurrence = crypto.randomUUID();
      const token = crypto.randomUUID();
      const record: Token = {
        purpose: "startup-terminal-action",
        owner: { ...owner },
        target: captured,
        occurrence,
        key: ownerLostActionKey(ownerId, owner.epoch, captured, occurrence),
      };
      tokens.set(token, record);
      try {
        const reply = await boundary.execute({
          principal: { kind: "owner-control", ...owner },
          ownerEpoch: owner.epoch,
          hostControl: token,
        }, {
          kind: OWNER_LOST_ACTION_RECOVERY,
          domain: "occurrence",
          key: record.key,
          intent: { ...captured, occurrence },
        });
        const result = reply.result as OwnerLostActionResult;
        if (
          reply.status !== "committed" ||
          !["exhausted", "cancelled"].includes(result.disposition)
        ) refuse("Selected Action terminal cleanup did not commit.");
        return result;
      } finally {
        tokens.delete(token);
      }
    },
  };
}
