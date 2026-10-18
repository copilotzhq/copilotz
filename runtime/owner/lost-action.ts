/** Private ordinary leased-Action takeover transition. This command never grants
 * execution/read authority or certifies owner readiness. Unsupported obligations
 * remain durable blockers for the independent exhaustive reconciliation proof. */
import { createActionLifecycleLoader } from "../actions/persistence.ts";
import { actionDefinitionHasSecrets } from "../actions/protected-lifecycle.ts";
import {
  type ActionRecoveryCatalog,
  recoverDeliveryActions,
} from "../actions/recovery.ts";
import { eventDataRef } from "../events/body-store.ts";
import {
  createEventCoordinator,
  type EventPublisher,
} from "../events/coordinator.ts";
import { createCoreTableNames } from "../events/schema.ts";
import type { SqlExecutor, SqlSession } from "../events/session.ts";
import { createEventStore } from "../events/store.ts";
import type { EventDelivery } from "../events/types.ts";
import { ownerClaimKey } from "../execution/owner-port.ts";
import {
  readExecutionClaim,
  type RegisteredExecutionContract,
} from "../execution/recovery.ts";
import type { DeliveryExecutor } from "../execution/types.ts";
import type { PluginRegistry } from "../plugins/registry.ts";
import {
  createOperationCatalogTables,
  type OperationCatalogCore,
  type OperationSettlementScope,
} from "../streams/catalog.ts";
import { createOwnerAssignmentStorage } from "./assignment-storage.ts";
import type {
  OwnerCaller,
  OwnerCommand,
  OwnerCommandContext,
  OwnerCommandHandler,
} from "./boundary.ts";
import { readOwnerEffectInventory } from "./effects.ts";
import { readOwnerOriginalExecutionContract } from "./execution-contract.ts";
import { ownerPrincipalIdentity } from "./principal.ts";
import { ownerReconciliationAlarm } from "./reconciliation.ts";
import { ownerTableNames } from "./schema.ts";

export const OWNER_LOST_ACTION_RECOVERY = "action.recoverLost";
type Target = Readonly<{ namespace: string; deliveryId: string }>;
type RecoveryIdentity = Readonly<
  Target & {
    ownerId: string;
    actionId: string;
    actionRunId: string;
    sourceEventId: string;
    priorEpoch: number;
    contract: RegisteredExecutionContract;
  }
>;
export type OwnerLostActionResult = Readonly<
  Target & {
    disposition: "blocked" | "retry" | "exhausted" | "cancelled";
    reason: string;
  }
>;
export function ownerLostActionKey(
  ownerId: string,
  epoch: number,
  target: Target,
  occurrence: string,
): string {
  return JSON.stringify([
    OWNER_LOST_ACTION_RECOVERY,
    ownerId,
    epoch,
    target.namespace,
    target.deliveryId,
    occurrence,
  ]);
}
function text(value: unknown): asserts value is string {
  if (
    typeof value !== "string" || !value.trim() || value !== value.trim() ||
    value.length > 1024
  ) throw new TypeError("Invalid lost Action identity.");
}
function refuse(message = "Owner lost Action control refused."): never {
  throw Object.assign(new Error(message), {
    code: "owner_lost_action_refused",
  });
}
export function createOwnerLostActionRecovery(
  options: Readonly<{
    ownerId: string;
    schema: string;
    session: SqlSession;
    registry: PluginRegistry;
    catalog: OperationCatalogCore & ActionRecoveryCatalog;
    executor: DeliveryExecutor;
    publish?: EventPublisher;
    maxAssignments?: number;
    maxAlarms?: number;
    maxConsumers?: number;
    authorizeControl(
      tx: SqlExecutor,
      caller: OwnerCaller,
      target: Target,
      commandTime: string,
    ): boolean | Promise<boolean>;
    /** SQL-only current recovery policy. It permits only requeue; the actual new
     * assignment must independently satisfy its exact worker/session contract. */
    authorizeRecoveryTransition?(
      tx: SqlExecutor,
      identity: RecoveryIdentity,
      commandTime: string,
    ): boolean | Promise<boolean>;
    scheduleSettlement(
      context: OwnerCommandContext,
      scope: OperationSettlementScope,
    ): void | Promise<void>;
    /** Nonawaited bounded scheduling hint; durable alarms remain authoritative. */
    wake?(target: Target): void;
  }>,
) {
  const {
    ownerId,
    schema,
    session,
    catalog,
    executor,
    publish,
    authorizeControl,
    authorizeRecoveryTransition,
    scheduleSettlement,
    wake,
  } = options;
  text(ownerId);
  if (
    catalog.databaseSchema !== schema ||
    typeof authorizeControl !== "function" ||
    typeof scheduleSettlement !== "function"
  ) {
    throw new TypeError(
      "Lost Action recovery needs matching catalog and current control/scheduling capabilities.",
    );
  }
  const maxAssignments = options.maxAssignments ?? 100;
  const maxAlarms = options.maxAlarms ?? 10_000;
  const maxConsumers = options.maxConsumers ?? 100;
  for (
    const [value, maximum] of [[maxAssignments, 1000], [maxAlarms, 100_000], [
      maxConsumers,
      1000,
    ]]
  ) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new TypeError("Invalid lost Action bound.");
    }
  }
  const core = createCoreTableNames(schema);
  const operations = createOperationCatalogTables(schema);
  const tables = ownerTableNames(schema);
  const storage = createOwnerAssignmentStorage({ ownerId, schema });
  const ids = new Map<string, number>();
  const ordinary = new Set<string>();
  for (const action of Object.values(options.registry.actions)) {
    ids.set(action.id, (ids.get(action.id) ?? 0) + 1);
    if (
      !action.content && !action.resolve && !actionDefinitionHasSecrets(action)
    ) ordinary.add(action.id);
  }
  const durableConsumers = options.registry.durableConsumers.bind(
    options.registry,
  );
  const registry: PluginRegistry = {
    ...options.registry,
    durableConsumers(draft, data) {
      const result = durableConsumers(draft, data);
      if (result.length > maxConsumers) {
        return refuse("Recovery terminal consumer capacity exceeded.");
      }
      return result;
    },
  };
  const authorized = new WeakMap<
    SqlExecutor,
    Readonly<Target & { epoch: number }>
  >();
  const handler: OwnerCommandHandler = async (_input, context) => {
    const selected = authorized.get(context.tx);
    authorized.delete(context.tx);
    if (!selected || selected.epoch !== context.ownerCommit.epoch) {
      return refuse();
    }
    const target = {
      namespace: selected.namespace,
      deliveryId: selected.deliveryId,
    };
    let cancelled = false;
    let registrationsOpen = true;
    const publications: Array<() => void | Promise<void>> = [];
    const stagedContext: OwnerCommandContext = {
      ...context,
      afterCommit(callback) {
        if (!registrationsOpen || publications.length >= 4) {
          return refuse("Recovery publication capacity exceeded.");
        }
        publications.push(callback);
      },
    };
    const store = createEventStore({
      session,
      schema,
      ownerCommit: {
        ...context.ownerCommit,
        afterCommit: stagedContext.afterCommit,
      },
      lockSettlementScope: (tx, scope) => catalog.lockScope(tx, scope),
      assertOperationCatalog: catalog.assertFormat,
      admitOperationEventSql: (value, param) =>
        catalog.admitEventSql(value, param),
      indexOperationEventSql: (value, param) =>
        catalog.indexEventSql(value, param),
      indexOperationEvent: (tx, value) => catalog.indexEvent(tx, value),
      settleActionOwners: (tx, delivery) =>
        recoverDeliveryActions(
          {
            store,
            coordinator,
            catalog,
            actions: registry.actions,
            commandTime: context.commandTime,
            ...(cancelled
              ? {
                deliveryCancellation: {
                  namespace: target.namespace,
                  operationId: delivery.settlementScopeId,
                },
              }
              : {}),
            async hasUnresolvedEffect(transaction, reference) {
              return (await readOwnerEffectInventory(transaction, {
                ...reference,
                ownerId,
                schema,
              })).some((effect) => effect.status === "begun");
            },
          },
          tx,
          delivery,
        ),
    });
    const coordinator = createEventCoordinator({
      store,
      registry,
      executor,
      publish,
      scheduleOnly: true,
    });
    const finish = async (
      disposition: OwnerLostActionResult["disposition"],
      reason: string,
      delivery?: EventDelivery,
    ): Promise<OwnerLostActionResult> => {
      if (delivery) {
        await scheduleSettlement(stagedContext, {
          namespace: target.namespace,
          operationId: delivery.settlementScopeId,
        });
      }
      const alarm = ownerReconciliationAlarm(ownerId, {
        kind: "delivery",
        namespace: target.namespace,
        id: target.deliveryId,
      });
      const other = await context.tx.query(
        `SELECT 1 FROM ${tables.alarms} WHERE owner=$1 AND name<>$2 LIMIT $3`,
        [ownerId, alarm, maxAlarms],
      );
      if (other.rows.length >= maxAlarms) {
        return refuse("Recovery alarm capacity exceeded.");
      }
      await context.tx.query(
        `INSERT INTO ${tables.alarms}(owner,name,due_at) VALUES($1,$2,$3::timestamptz) ON CONFLICT(owner,name) DO UPDATE SET due_at=EXCLUDED.due_at`,
        [
          ownerId,
          alarm,
          disposition === "retry" ? delivery!.availableAt : context.commandTime,
        ],
      );
      registrationsOpen = false;
      context.afterCommit(async () => {
        const failures: unknown[] = [];
        for (const publish of publications) {
          try {
            await publish();
          } catch (error) {
            failures.push(error);
          }
        }
        try {
          wake?.({ ...target });
        } catch (error) {
          failures.push(error);
        }
        if (failures.length) {
          throw new AggregateError(
            failures,
            "Lost Action scheduling failed; durable obligations remain.",
          );
        }
      });
      return { ...target, disposition, reason };
    };
    const block = (reason: string) => finish("blocked", reason);
    try {
      // Check retained byte sizes before hydrating source/canonical lifecycle JSON.
      const boundedSource = await context.tx.query<{ allowed: boolean }>(
        `SELECT octet_length(e.payload::text)+octet_length(e.metadata::text)<=2097152 AS allowed FROM ${core.event_deliveries} d JOIN ${core.events} e ON e.id=d.event_id WHERE d.id=$1`,
        [target.deliveryId],
      );
      if (boundedSource.rows.length !== 1 || !boundedSource.rows[0].allowed) {
        return await block("source_missing_or_oversized");
      }
      let delivery = await store.getDelivery(target.deliveryId);
      if (!delivery) return await block("delivery_missing");
      const source = await store.getEvent(delivery.eventId);
      if (
        !source || source.ownerId !== ownerId ||
        source.namespace !== target.namespace ||
        source.type !== "copilotz.owner.action.requested"
      ) return await block("source_identity_mismatch");
      const actionId = source.metadata.actionId;
      const actionRunId = source.metadata.actionRunId;
      if (
        typeof actionId !== "string" || typeof actionRunId !== "string" ||
        ids.get(actionId) !== 1 || !ordinary.has(actionId) ||
        delivery.consumerId !== `registered:${actionId}`
      ) return await block("unsupported_action");
      text(actionId);
      text(actionRunId);
      if (source.deduplicationId !== actionRunId) {
        return await block("source_run_mismatch");
      }
      // Lock operation -> delivery -> assignment -> open Action. The epoch fence
      // already excludes old mutators, even while an old external call may run.
      const scope = (await context.tx.query<
        {
          state: string;
          cancellation_requested_at: unknown;
          root_owner: string;
          root_namespace: string;
        }
      >(
        `SELECT o.state,o.cancellation_requested_at,e.owner_id AS root_owner,e.namespace AS root_namespace FROM ${operations.operations} o LEFT JOIN ${core.events} e ON e.id=o.root_event_id WHERE o.namespace=$1 AND o.operation_id=$2 FOR UPDATE OF o`,
        [target.namespace, delivery.settlementScopeId],
      )).rows[0];
      if (
        !scope || scope.root_owner !== ownerId ||
        scope.root_namespace !== target.namespace ||
        !["accepted", "running"].includes(scope.state)
      ) return await block("scope_identity_or_state_mismatch");
      cancelled = scope.cancellation_requested_at !== null;
      // Preserve the exact historical deadline under the existing lock. The
      // public EventDelivery mapper normalizes through JavaScript Date;
      // using it as the CAS witness would round a retained PostgreSQL instant.
      const leaseExpiresAt =
        (await context.tx.query<{ lease_expires_at: string | null }>(
          `SELECT lease_expires_at::text AS lease_expires_at FROM ${core.event_deliveries} WHERE id=$1 FOR UPDATE`,
          [delivery.id],
        )).rows[0]?.lease_expires_at;
      const current = await store.getDelivery(delivery.id);
      if (
        leaseExpiresAt === undefined || !current ||
        current.eventId !== delivery.eventId ||
        current.settlementScopeId !== delivery.settlementScopeId
      ) return await block("delivery_changed");
      delivery = current;
      if (
        delivery.status !== "leased" || !delivery.leaseOwner ||
        delivery.attempts < 1
      ) return await block("not_a_lost_worker_attempt");
      const rows = await storage.listDelivery(context.ownerCommit, {
        ...target,
        maxAssignments,
      });
      if (!rows.length) return await block("claim_without_assignment");
      for (const row of rows) {
        const b = row.binding;
        if (row.epoch >= selected.epoch) {
          return await block(
            row.epoch === selected.epoch
              ? "current_epoch_assignment"
              : "future_epoch_assignment",
          );
        }
        if (
          b.placement !== "worker" || "kind" in b || b.actionId !== actionId ||
          b.executionId !== actionRunId || b.sourceEventId !== source.id
        ) return await block("unsupported_or_mismatched_assignment");
      }
      const matching = rows.filter((row) =>
        row.binding.placement === "worker" &&
        row.binding.dispatchAttemptId === delivery!.leaseOwner
      );
      if (matching.length !== 1) {
        return await block("lost_assignment_not_unique");
      }
      const lost = matching[0];
      const binding = lost.binding;
      if (binding.placement !== "worker" || "kind" in binding) {
        return await block("unsupported_assignment");
      }
      if (rows.some((row) => !row.retired && row.key !== lost.key)) {
        return await block("conflicting_live_assignment");
      }
      const claimRows = (await context.tx.query<
        {
          kind: string;
          principal_kind: string;
          principal_id: string;
          intent: unknown;
          result: unknown;
        }
      >(
        `SELECT kind,principal_kind,principal_id,CASE WHEN octet_length(intent::text)<=8192 THEN intent ELSE NULL END AS intent,CASE WHEN octet_length(result::text)<=32768 THEN result ELSE NULL END AS result FROM ${tables.receipts} WHERE owner=$1 AND domain='incarnation' AND key=$2`,
        [
          ownerId,
          ownerClaimKey(ownerId, binding.assignmentId, binding.sessionId),
        ],
      )).rows;
      const row = claimRows[0];
      const principal = ownerPrincipalIdentity({
        kind: "worker",
        workerId: binding.workerId,
      });
      if (
        claimRows.length !== 1 || row.kind !== "execution.claim" ||
        row.principal_kind !== principal.kind ||
        row.principal_id !== principal.id
      ) return await block("lost_claim_missing_or_mismatched");
      const intent = row.intent as Record<string, unknown> | null;
      if (
        !intent || typeof intent !== "object" || Array.isArray(intent) ||
        Object.keys(intent).sort().join(",") !== "assignmentId,sessionId" ||
        intent.assignmentId !== binding.assignmentId ||
        intent.sessionId !== binding.sessionId
      ) return await block("lost_claim_intent_mismatch");
      let claim: ReturnType<typeof readExecutionClaim>;
      try {
        claim = readExecutionClaim(row.result);
      } catch {
        return await block("lost_claim_malformed");
      }
      if (
        claim.reference.executionId !== actionRunId ||
        claim.reference.deliveryId !== delivery.id ||
        claim.reference.dispatchAttemptId !== binding.dispatchAttemptId ||
        (delivery.attempts === 1 ? !!claim.recovery : !claim.recovery)
      ) return await block("lost_claim_attempt_mismatch");
      if (
        claim.contract && (
          claim.contract.ownerId !== ownerId ||
          claim.contract.ownerEpoch !== lost.epoch ||
          claim.contract.namespace !== target.namespace ||
          claim.contract.actionId !== actionId ||
          claim.contract.actionRunId !== actionRunId ||
          claim.contract.sourceEventId !== source.id ||
          claim.contract.deliveryId !== delivery.id ||
          claim.contract.workerId !== binding.workerId ||
          claim.contract.assignmentId !== binding.assignmentId ||
          claim.contract.sessionId !== binding.sessionId ||
          claim.contract.dispatchAttemptId !== binding.dispatchAttemptId
        )
      ) return await block("lost_contract_binding_mismatch");
      const terminal = await context.tx.query(
        `SELECT 1 FROM ${core.events} WHERE namespace=$1 AND deduplication_id=$2 LIMIT 1`,
        [target.namespace, `${actionRunId}:action:terminal`],
      );
      if (terminal.rows.length) return await block("terminal_with_live_lease");
      const open = (await context.tx.query<
        {
          namespace: string;
          action_run_id: string;
          action_id: string;
          scope_id: string;
          action_scope_id: string | null;
          owner_delivery_id: string;
          invoked_event_id: string;
          state: string;
          supported: boolean;
        }
      >(
        `SELECT namespace,action_run_id,action_id,scope_id,action_scope_id,owner_delivery_id,invoked_event_id,state,(deferred_event_id IS NULL AND wait_key IS NULL AND wait_signaled=FALSE AND wait_expires_at IS NULL AND resolve_generation=0) AS supported FROM ${core.open_actions} WHERE owner_delivery_id=$1 OR (namespace=$2 AND action_run_id=$3) ORDER BY namespace,action_run_id LIMIT 2 FOR UPDATE`,
        [delivery.id, target.namespace, actionRunId],
      )).rows;
      if (
        open.length !== 1 || open[0].namespace !== target.namespace ||
        open[0].action_run_id !== actionRunId ||
        open[0].action_id !== actionId ||
        open[0].owner_delivery_id !== delivery.id ||
        open[0].scope_id !== delivery.settlementScopeId ||
        open[0].action_scope_id !== (delivery.actionScopeId ?? null) ||
        open[0].state !== "invoked" || !open[0].supported
      ) return await block("unsupported_or_mismatched_action_obligation");
      if (
        (await context.tx.query(
          `SELECT 1 FROM ${operations.operationStreams} WHERE namespace=$1 AND operation_id=$2 LIMIT 1`,
          [target.namespace, delivery.settlementScopeId],
        )).rows.length
      ) return await block("stream_recovery_unsupported");
      const boundedInvoked = (await context.tx.query<{ allowed: boolean }>(
        `SELECT octet_length(payload::text)+octet_length(metadata::text)<=2097152 AS allowed FROM ${core.events} WHERE id=$1`,
        [open[0].invoked_event_id],
      )).rows[0];
      if (!boundedInvoked?.allowed) {
        return await block("invoked_event_missing_or_oversized");
      }
      const invokedEvent = await store.getEventByDeduplicationId(
        target.namespace,
        `${actionRunId}:action:invoked`,
      );
      if (
        !invokedEvent || invokedEvent.id !== open[0].invoked_event_id ||
        invokedEvent.ownerId !== ownerId ||
        invokedEvent.causationId !== source.id ||
        invokedEvent.correlationId !== source.correlationId ||
        invokedEvent.metadata.sourceDeliveryId !== delivery.id
      ) return await block("invoked_identity_mismatch");
      // A matching lifecycle body is not sufficient provenance. Both immutable
      // events must be indexed in this exact delivery scope. Compare positions
      // in SQL so bigint coordinates never cross a lossy JS numeric boundary.
      // Do not filter by expected namespace/scope: conflicting rows must refuse.
      const indexed = (await context.tx.query<{
        event_id: string;
        namespace_matches: boolean;
        scope_matches: boolean;
        position_matches: boolean;
      }>(
        `SELECT i.event_id,(i.namespace=$3) AS namespace_matches,(i.operation_id=$4) AS scope_matches,(i.event_position=e.position) AS position_matches FROM ${operations.operationEvents} i JOIN ${core.events} e ON e.id=i.event_id WHERE i.event_id IN ($1,$2) ORDER BY i.event_id LIMIT 3 FOR UPDATE OF i`,
        [
          source.id,
          invokedEvent.id,
          target.namespace,
          delivery.settlementScopeId,
        ],
      )).rows;
      if (
        indexed.length !== 2 ||
        indexed.filter((row) => row.event_id === source.id).length !== 1 ||
        indexed.filter((row) => row.event_id === invokedEvent.id).length !==
          1 ||
        indexed.some((row) =>
          row.namespace_matches !== true ||
          row.scope_matches !== true ||
          row.position_matches !== true
        )
      ) return await block("lifecycle_catalog_mismatch");
      let invokedBodyId: string;
      try {
        invokedBodyId = eventDataRef(invokedEvent.payload).eventBodyId;
      } catch {
        return await block("invoked_body_invalid");
      }
      const size = (await context.tx.query<{ allowed: boolean }>(
        `SELECT octet_length(body::text)<=2097152 AS allowed FROM ${core.event_bodies} WHERE namespace=$1 AND event_body_id=$2`,
        [target.namespace, invokedBodyId],
      )).rows;
      if (size.length !== 1 || !size[0].allowed) {
        return await block("invoked_body_missing_or_oversized");
      }
      const load = createActionLifecycleLoader({
        store,
        actions: registry.actions,
      });
      let invoked: Awaited<ReturnType<typeof load>>;
      try {
        invoked = await load(target.namespace, `${actionRunId}:action:invoked`);
      } catch {
        return await block("invoked_body_invalid");
      }
      if (
        !invoked || invoked.status !== "invoked" ||
        invoked.actionId !== actionId || invoked.actionRunId !== actionRunId
      ) return await block("invoked_body_mismatch");
      const effects = await readOwnerEffectInventory(context.tx, {
        ownerId,
        schema,
        namespace: target.namespace,
        actionRunId,
      });
      const disposition: "retry" | "exhausted" | "cancelled" = cancelled
        ? "cancelled"
        : delivery.attempts >= delivery.maxAttempts
        ? "exhausted"
        : "retry";
      if (disposition === "retry") {
        const contract = await readOwnerOriginalExecutionContract(context.tx, {
          ownerId,
          schema,
          epoch: lost.epoch,
          namespace: target.namespace,
          actionId,
          actionRunId,
          sourceEventId: source.id,
          deliveryId: delivery.id,
        });
        if (!contract) return await block("original_contract_unproven");
        const original = rows.filter((candidate) =>
          candidate.epoch === contract.ownerEpoch &&
          candidate.binding.placement === "worker" &&
          candidate.binding.workerId === contract.workerId &&
          candidate.binding.assignmentId === contract.assignmentId &&
          candidate.binding.sessionId === contract.sessionId &&
          candidate.binding.dispatchAttemptId === contract.dispatchAttemptId
        );
        if (original.length !== 1) {
          return await block("original_assignment_unproven");
        }
        if (
          delivery.attempts === 1 &&
          (!claim.contract || claim.contract.ownerEpoch !== lost.epoch ||
            claim.contract.workerId !== binding.workerId ||
            claim.contract.assignmentId !== binding.assignmentId ||
            claim.contract.sessionId !== binding.sessionId)
        ) return await block("original_claim_contract_mismatch");
        if (claim.recovery && claim.recovery.status !== "eligible") {
          return await block("prior_retry_was_blocked");
        }
        const now = new Map(
          effects.map((effect) => [effect.step, effect.status]),
        );
        if (
          effects.some((effect) => effect.status === "begun") ||
          claim.recovery?.effects.some((effect) =>
            !now.has(effect.step) ||
            (effect.status !== "begun" &&
              now.get(effect.step) !== effect.status)
          )
        ) return await block("effect_reconciliation_required");
        if (
          await authorizeRecoveryTransition?.(
            context.tx,
            structuredClone({
              ...target,
              ownerId,
              actionId,
              actionRunId,
              sourceEventId: source.id,
              priorEpoch: lost.epoch,
              contract,
            }),
            context.commandTime,
          ) !== true
        ) return await block("current_recovery_policy_refused");
      }
      const transitioned = await store.recoverLostDelivery({
        namespace: target.namespace,
        id: delivery.id,
        eventId: delivery.eventId,
        consumerId: delivery.consumerId,
        settlementScopeId: delivery.settlementScopeId,
        ...(delivery.actionScopeId
          ? { actionScopeId: delivery.actionScopeId }
          : {}),
        leaseOwner: delivery.leaseOwner!,
        leaseExpiresAt,
        attempts: delivery.attempts,
        maxAttempts: delivery.maxAttempts,
        disposition,
      });
      if (!transitioned) {
        return refuse("Lost delivery changed during recovery.");
      }
      if (
        !lost.retired && !await storage.retirePrior(context.ownerCommit, lost)
      ) return refuse("Prior assignment changed during recovery.");
      return await finish(
        disposition,
        disposition === "retry"
          ? "historical_and_current_recovery_proven"
          : "canonical_terminal_written",
        transitioned,
      );
    } finally {
      registrationsOpen = false;
    }
  };
  return {
    handlers: { [OWNER_LOST_ACTION_RECOVERY]: handler },
    async authorize(
      tx: SqlExecutor,
      caller: OwnerCaller,
      command: OwnerCommand,
      commandTime: string,
    ) {
      authorized.delete(tx);
      if (caller.principal.kind !== "owner-control") return refuse();
      const input = command.intent as Record<string, unknown> | null;
      if (
        !input || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).sort().join(",") !==
          "deliveryId,namespace,occurrence"
      ) throw new TypeError("Invalid lost Action recovery request.");
      text(input.namespace);
      text(input.deliveryId);
      text(input.occurrence);
      const target = {
        namespace: input.namespace,
        deliveryId: input.deliveryId,
      };
      if (
        command.kind !== OWNER_LOST_ACTION_RECOVERY ||
        command.domain !== "occurrence" ||
        command.key !==
          ownerLostActionKey(
            ownerId,
            caller.ownerEpoch,
            target,
            input.occurrence,
          )
      ) return refuse();
      if (
        await authorizeControl(
          tx,
          structuredClone(caller),
          { ...target },
          commandTime,
        ) !== true
      ) return refuse();
      authorized.set(tx, { ...target, epoch: caller.ownerEpoch });
    },
  };
}
