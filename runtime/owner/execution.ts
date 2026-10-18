/** Private ordinary-JSON Action execution on the existing delivery/lifecycle tables.
 * The trusted host has already selected an Action and a body-backed input event.
 * This is not a generic Processor-event-to-Action conversion or a public factory. */
import {
  ownerAuthorityLock,
  type OwnerAuthorityReadMode,
} from "./authority-read.ts";
import type {
  ActionInvokedData,
  AnyActionDefinition,
} from "../actions/types.ts";
import { createActionLifecycleEmitter } from "../actions/lifecycle.ts";
import {
  createActionLifecycleAppender,
  createActionLifecycleLoader,
} from "../actions/persistence.ts";
import { actionDefinitionHasSecrets } from "../actions/protected-lifecycle.ts";
import {
  type ActionRecoveryCatalog,
  recoverDeliveryActions,
} from "../actions/recovery.ts";
import { validateAgainstJsonSchema } from "../collections/validate.ts";
import { eventDataRef, readEventBody } from "../events/body-store.ts";
import {
  createEventCoordinator,
  type EventPublisher,
} from "../events/coordinator.ts";
import { createCoreTableNames } from "../events/schema.ts";
import type { SqlExecutor, SqlSession } from "../events/session.ts";
import {
  createEventStore,
  type CreateEventStoreOptions,
  type EventStore,
} from "../events/store.ts";
import type { DurableEvent, EventDelivery } from "../events/types.ts";
import type { OwnerPreparedInputContext } from "./preparation.ts";
import {
  OWNER_PREPARATION_METADATA,
  preparationCaptureFromMetadata,
} from "./preparation-capture.ts";
import type { DeliveryExecutor } from "../execution/types.ts";
import type {
  RegisteredExecutionCompletion,
  RegisteredExecutionProjection,
  RegisteredExecutionReference,
} from "../execution/registered-worker.ts";
import { ownerClaimKey, ownerCompletionKey } from "../execution/owner-port.ts";
import { assertJsonValue } from "../json.ts";
import { digestContent } from "../content/digest.ts";
import {
  OWNER_EFFECT_EXECUTION_CONTRACT,
  readExecutionClaim,
  type RegisteredExecutionContract,
} from "../execution/recovery.ts";
import { readOwnerOriginalExecutionContract } from "./execution-contract.ts";
import type { RegisteredExecutionRecovery } from "../execution/recovery.ts";
import { readOwnerEffectInventory } from "./effects.ts";
import { ownerTableNames } from "./schema.ts";
import { ownerPrincipalIdentity } from "./principal.ts";
import {
  type OwnerLocalActionAssignmentBinding,
  parseOwnerPlacementBinding,
} from "./assignments.ts";
import {
  assertOwnerAttemptCaller,
  ownerAttemptIsLive,
  ownerAttemptToken,
  ownerEventCommitForAttempt,
} from "./attempt-authority.ts";
import type { RegisteredActionInvocation } from "../execution/registered-invocation.ts";
import type { PluginRegistry } from "../plugins/registry.ts";
import {
  createOperationCatalogTables,
  type OperationCatalogCore,
  type OperationSettlementScope,
} from "../streams/catalog.ts";
import type {
  OwnerCaller,
  OwnerCommand,
  OwnerCommandContext,
  OwnerCommandHandler,
  OwnerCommandInputDefinition,
  OwnerJson,
  OwnerProjectionHandler,
} from "./boundary.ts";

/** Current, host-owned state. The resolver must verify the live parent transport
 * assignment/session, not reproduce bindings supplied in a command payload.
 * Each dispatchAttemptId is host-issued and never reused by a replacement. */
export type OwnerWorkerExecutionAssignment = Readonly<{
  placement: "worker";
  ownerId: string;
  workerId: string;
  assignmentId: string;
  sessionId: string;
  namespace: string;
  actionId: string;
  deliveryId: string;
  dispatchAttemptId: string;
  ctxGranted: boolean;
  settlementGranted: boolean;
  invocation: RegisteredExecutionProjection["invocation"];
}>;

export type OwnerLocalExecutionAssignment =
  & OwnerLocalActionAssignmentBinding
  & Readonly<{
    ctxGranted: boolean;
    settlementGranted: boolean;
    invocation: RegisteredActionInvocation["invocation"];
  }>;
export type OwnerExecutionAssignment =
  | OwnerWorkerExecutionAssignment
  | OwnerLocalExecutionAssignment;
/** Internal projection only. It never enters the worker projection decoder. */
export type OwnerLocalActionProjection =
  & RegisteredActionInvocation
  & Readonly<{
    reference: OwnerLocalActionAssignmentBinding;
  }>;
function localBinding(
  value: OwnerLocalActionAssignmentBinding,
): OwnerLocalActionAssignmentBinding {
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw new TypeError("Local Action binding required.");
  }
  const fields = [
    "placement",
    "ownerId",
    "epoch",
    "holderId",
    "attemptId",
    "namespace",
    "sourceEventId",
    "deliveryId",
    "kind",
    "actionId",
    "actionRunId",
  ];
  const snapshot: Record<string, unknown> = {};
  for (const field of fields) {
    const property = Object.getOwnPropertyDescriptor(value, field);
    if (!property?.enumerable || !("value" in property)) {
      throw new TypeError(
        "Local Action binding requires own data coordinates.",
      );
    }
    snapshot[field] = property.value;
  }
  const binding = parseOwnerPlacementBinding(snapshot);
  if (binding.placement !== "owner-local" || binding.kind !== "action") {
    throw new TypeError("Local Action binding required.");
  }
  return binding;
}
export function ownerLocalActionStartKey(
  binding: OwnerLocalActionAssignmentBinding,
): string {
  const value = localBinding(binding);
  return JSON.stringify([
    "owner.local-start",
    1,
    value.ownerId,
    value.epoch,
    value.holderId,
    value.deliveryId,
    value.attemptId,
  ]);
}

type Authorized = Readonly<{
  caller: OwnerCaller;
  prepared: boolean;
  assignment: OwnerExecutionAssignment;
  action: AnyActionDefinition;
  delivery: EventDelivery;
  cancelled: boolean;
  correlationId: string;
  source: Pick<DurableEvent, "id" | "ownerId" | "namespace" | "correlationId">;
}>;
function refuse(message: string): never {
  throw Object.assign(new Error(message), {
    name: "ActionOwnershipLost",
    code: "ActionOwnershipLost",
  });
}
function object(
  input: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  assertJsonValue(input, {
    maxDepth: 64,
    maxNodes: 100_000,
    rejectNegativeZero: true,
  });
  if (
    !input || typeof input !== "object" || Array.isArray(input) ||
    Object.keys(input).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(input, key))
  ) throw new TypeError("Invalid owner execution data.");
  return input as Record<string, unknown>;
}
function text(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 1024) {
    throw new TypeError("Invalid owner execution identity.");
  }
}
function json(input: unknown): OwnerJson {
  assertJsonValue(input, {
    maxDepth: 64,
    maxNodes: 100_000,
    rejectNegativeZero: true,
  });
  if (
    new TextEncoder().encode(JSON.stringify(input)).byteLength > 1024 * 1024
  ) {
    throw new TypeError("Owner execution data exceeds its limit.");
  }
  return structuredClone(input) as OwnerJson;
}
function ordered(value: OwnerJson): OwnerJson {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map(
        (key) => [key, ordered((value as Record<string, OwnerJson>)[key])],
      ),
    );
  }
  return value;
}
const completionInput: OwnerCommandInputDefinition = {
  async normalize(input) {
    const data = object(input, ["namespace", "executionId", "completion"]);
    text(data.namespace);
    text(data.executionId);
    const value = ordered(
      json({
        namespace: data.namespace,
        executionId: data.executionId,
        completion: completion(data.completion),
      }),
    );
    const digest = await digestContent(
      new TextEncoder().encode(JSON.stringify(value)),
    );
    return {
      intent: { encoding: "copilotz.action-completion.v1", digest },
      value,
    };
  },
};
function reference(
  assignment: OwnerExecutionAssignment,
):
  | RegisteredExecutionReference
  | Readonly<{ reference: OwnerLocalActionAssignmentBinding }> {
  if (assignment.placement === "owner-local") {
    return { reference: localBinding(assignment) };
  }
  return {
    executionId: assignment.invocation.actionRunId,
    deliveryId: assignment.deliveryId,
    dispatchAttemptId: assignment.dispatchAttemptId,
  };
}
function checkReference(
  input: unknown,
  assignment: OwnerExecutionAssignment,
): void {
  if (assignment.placement === "owner-local") {
    const value = parseOwnerPlacementBinding(input);
    if (JSON.stringify(value) !== JSON.stringify(localBinding(assignment))) {
      refuse("Local execution reference is not current.");
    }
    return;
  }
  const data = object(input, [
    "executionId",
    "deliveryId",
    "dispatchAttemptId",
  ]);
  const expected = reference(assignment) as RegisteredExecutionReference;
  for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
    if (data[key] !== expected[key]) {
      refuse("Execution reference is not current.");
    }
  }
}
function completion(input: unknown): RegisteredExecutionCompletion {
  const status = (input as { status?: unknown } | null)?.status;
  const data = object(
    input,
    status === "completed" ? ["status", "output"] : ["status", "code"],
  );
  if (status === "completed") return { status, output: json(data.output) };
  if (status !== "failed" && status !== "cancelled") {
    throw new TypeError("Unsupported execution completion.");
  }
  // Error messages, stacks and arbitrary provider details never become receipts.
  const allowed = status === "cancelled" ? ["action_cancelled"] : [
    "action_failed",
    "action_capability_unsupported",
    "effect_indeterminate",
  ];
  if (typeof data.code !== "string" || !allowed.includes(data.code)) {
    throw new TypeError("Invalid safe execution failure code.");
  }
  return { status, code: data.code };
}

export function createOwnerExecutionCommands(
  options: Readonly<{
    ownerId: string;
    session: SqlSession;
    schema: string;
    registry: PluginRegistry;
    catalog: OperationCatalogCore & ActionRecoveryCatalog;
    executor: DeliveryExecutor;
    publish?: EventPublisher;
    /** Runtime hosts supply an exact synchronous private witness. This runs
     * after the final SQL read and does not replace durable/policy checks. */
    isCurrentAssignment?(
      caller: OwnerCaller,
      assignment: OwnerExecutionAssignment,
    ): boolean;
    /** Dormant host-private local composition. Missing capability fails closed.
     * authorizeStart must affirm the exact current control/capacity entry and
     * current permission to start this Action and access its input. */
    local?: Readonly<{
      authorizeStart(
        tx: SqlExecutor,
        caller: OwnerCaller,
        binding: OwnerLocalActionAssignmentBinding,
        commandTime: string,
      ): boolean | Promise<boolean>;
      reserveLocal(
        context: OwnerCommandContext,
        binding: OwnerLocalActionAssignmentBinding,
      ): Promise<void>;
      retireLocal(
        context: OwnerCommandContext,
        binding: OwnerLocalActionAssignmentBinding,
      ): Promise<void>;
    }>;
    /** Joins the current command and only enqueues a check after outer commit.
     * No drain or dependent execution may be awaited here. */
    scheduleSettlement?(
      context: OwnerCommandContext,
      scope: OperationSettlementScope,
    ): void | Promise<void>;
    /** SQL-only current host authorization, always called inside boundary.authorize. */
    resolveAssignment(
      tx: SqlExecutor,
      caller: OwnerCaller,
      commandTime: string,
      readMode?: OwnerAuthorityReadMode,
    ):
      | OwnerExecutionAssignment
      | undefined
      | Promise<OwnerExecutionAssignment | undefined>;
    /** Transitional SQL-only assertion about the exact assigned worker/session's
     * registered Action and Adapter execution contract, not merely today's
     * Action name. No worker data or current deployment change establishes the
     * historical fact. A positive original fresh claim records the versioned
     * contract atomically; missing/false evidence cannot later be upgraded.
     * Defaults to recovery refusal, even with no effect receipts. Rechecked on
     * retry admission, recovery projection and every ordinary mutation. */
    allowRecovery?(
      tx: SqlExecutor,
      assignment: OwnerExecutionAssignment,
      actionId: string,
      commandTime: string,
    ): boolean | Promise<boolean>;
    /** Mandatory for lifecycle input with preparation metadata. Runs before
     * claim/input/mutation receipts and again before captured input release.
     * Safe completion and effect settlement do not reacquire source permission. */
    authorizePreparedInput?(
      tx: SqlExecutor,
      context: OwnerPreparedInputContext,
    ): void | Promise<void>;
    /** Mandatory current input policy. Called before capture, projection and mutation.
     * It may inspect current policy through tx; it must perform no external I/O.
     * This subset returns the complete ordinary captured input only when allowed. */
    authorizeInput(
      tx: SqlExecutor,
      assignment: OwnerExecutionAssignment,
      input: OwnerJson,
      commandTime: string,
    ): void | Promise<void>;
  }>,
): Readonly<{
  inputDefinitions: Readonly<Record<string, OwnerCommandInputDefinition>>;
  handlers: Readonly<Record<string, OwnerCommandHandler>>;
  projections: Readonly<Record<string, OwnerProjectionHandler>>;
  authorize(
    tx: SqlExecutor,
    caller: OwnerCaller,
    command: OwnerCommand,
    commandTime: string,
    normalizedInput?: OwnerJson,
  ): Promise<void>;
  authorizeLocalStart(
    tx: SqlExecutor,
    caller: OwnerCaller,
    binding: OwnerLocalActionAssignmentBinding,
    commandTime: string,
  ): Promise<void>;
  startLocal(
    binding: OwnerLocalActionAssignmentBinding,
    context: OwnerCommandContext,
  ): Promise<OwnerJson>;
  /** Narrow current-attempt settlement capability, including after ctx
   * revocation. The caller must separately bind the effect reference. */
  authorizeSettlement(
    tx: SqlExecutor,
    caller: OwnerCaller,
    commandTime: string,
  ): Promise<OwnerExecutionAssignment>;
  /** The same live authorization, retaining already-read immutable source facts. */
  authorizeLiveFacts(
    tx: SqlExecutor,
    caller: OwnerCaller,
    commandTime: string,
    readMode?: OwnerAuthorityReadMode,
  ): Promise<Pick<Authorized, "assignment" | "delivery" | "source">>;
  /** Same settlement grant, retaining original source and delivery coordinates. */
  authorizeSettlementFacts(
    tx: SqlExecutor,
    caller: OwnerCaller,
    commandTime: string,
  ): Promise<Pick<Authorized, "assignment" | "delivery" | "source">>;
  /** Composition seam for separately key-bound owner Collection commands. */
  authorizeLive(
    tx: SqlExecutor,
    caller: OwnerCaller,
    commandTime: string,
    readMode?: OwnerAuthorityReadMode,
  ): Promise<OwnerExecutionAssignment>;
}> {
  const allowRecovery = options.allowRecovery;
  const local = options.local && {
    authorizeStart: options.local.authorizeStart,
    reserveLocal: options.local.reserveLocal,
    retireLocal: options.local.retireLocal,
  };
  const authorizePreparedInput = options.authorizePreparedInput;
  text(options.ownerId);
  if (options.catalog.databaseSchema !== options.schema) {
    throw new TypeError("Execution catalog schema does not match.");
  }

  const tables = createCoreTableNames(options.schema);
  const operationTables = createOperationCatalogTables(options.schema);
  const isCurrentAssignment = options.isCurrentAssignment;
  if (
    isCurrentAssignment !== undefined &&
    typeof isCurrentAssignment !== "function"
  ) {
    throw new TypeError("isCurrentAssignment must be a function.");
  }

  const authorized = new WeakMap<SqlExecutor, Authorized>();
  const localStarts = new WeakMap<
    SqlExecutor,
    Readonly<{ state: Authorized; time: string }>
  >();
  async function authorizeStart(
    tx: SqlExecutor,
    caller: OwnerCaller,
    binding: OwnerLocalActionAssignmentBinding,
    commandTime: string,
  ) {
    const principal = caller.principal;
    ownerPrincipalIdentity(principal);
    if (
      !local || principal.kind !== "owner-control" ||
      principal.ownerId !== options.ownerId ||
      binding.ownerId !== options.ownerId ||
      principal.epoch !== binding.epoch ||
      caller.ownerEpoch !== binding.epoch ||
      principal.holderId !== binding.holderId
    ) {
      refuse("Current private local-start authority is required.");
    }
    const fence = await tx.query(
      `SELECT owner FROM ${ownerTableNames(options.schema).epochs}
      WHERE owner=$1 AND epoch=$2 AND holder=$3 FOR SHARE`,
      [binding.ownerId, binding.epoch, binding.holderId],
    );
    if (
      fence.rows.length !== 1 ||
      await local.authorizeStart(
          tx,
          structuredClone(caller),
          localBinding(binding),
          commandTime,
        ) !== true
    ) {
      refuse("Current private local-start authority is required.");
    }
  }

  async function current(
    tx: SqlExecutor,
    caller: OwnerCaller,
    commandTime: string,
    mode: "claim" | "input" | "complete" | "mutation",
    candidate?: OwnerLocalActionAssignmentBinding,
    readMode: OwnerAuthorityReadMode = "locking",
  ): Promise<Authorized> {
    const found = candidate
      ? {
        ...candidate,
        ctxGranted: true,
        settlementGranted: true,
        invocation: {
          actionRunId: candidate.actionRunId,
          rootKey: candidate.actionRunId,
          operationKey: candidate.actionRunId,
          metadata: {},
        },
      }
      : await options.resolveAssignment(tx, caller, commandTime, readMode);
    if (!found) refuse("Execution assignment is no longer current.");
    let assignment: OwnerExecutionAssignment = structuredClone(found);
    if (candidate) await authorizeStart(tx, caller, candidate, commandTime);
    else assertOwnerAttemptCaller(caller, assignment, options.ownerId);
    if (assignment.placement === "owner-local") {
      if (
        !local ||
        assignment.invocation.actionRunId !== assignment.actionRunId ||
        (!candidate && mode === "claim")
      ) {
        refuse("Local Actions require fresh control start and cannot renew.");
      }
    }
    for (
      const value of [
        assignment.namespace,
        assignment.actionId,
        assignment.deliveryId,
        assignment.invocation.actionRunId,
        assignment.invocation.rootKey,
        assignment.invocation.operationKey,
      ]
    ) text(value);
    if (
      mode === "complete"
        ? assignment.settlementGranted !== true
        : assignment.ctxGranted !== true
    ) {
      refuse("Execution authority was revoked.");
    }
    const actions = Object.values(options.registry.actions).filter((action) =>
      action.id === assignment.actionId
    );
    if (actions.length !== 1) {
      throw new TypeError("Registered Action is unavailable.");
    }
    const action = actions[0];
    if (
      action.content || action.resolve || actionDefinitionHasSecrets(action)
    ) {
      throw new TypeError(
        "Owner execution supports ordinary JSON Actions only; content, protected and deferred Actions are unsupported.",
      );
    }
    // Match the established operation -> delivery -> open Action lock order.
    const initial = await tx.query<
      {
        settlement_scope_id: string;
        action_scope_id: string | null;
        event_id: string;
        owner_id: string;
        type: string;
        deduplication_id: string;
        consumer_id: string;
        namespace: string;
        correlation_id: string;
        metadata: Record<string, unknown>;
      }
    >(
      `SELECT d.settlement_scope_id,d.action_scope_id,d.consumer_id,e.id AS event_id,e.owner_id,e.type,e.deduplication_id,e.namespace,e.correlation_id,e.metadata FROM ${tables.event_deliveries} d JOIN ${tables.events} e ON e.id=d.event_id WHERE d.id=$1`,
      [assignment.deliveryId],
    );
    const source = initial.rows[0];
    if (!source || source.namespace !== assignment.namespace) {
      refuse("Execution delivery does not belong to this namespace.");
    }
    if (assignment.placement === "owner-local") {
      if (
        source.owner_id !== options.ownerId ||
        source.event_id !== assignment.sourceEventId ||
        source.type !== "copilotz.owner.action.requested" ||
        source.deduplication_id !== assignment.actionRunId ||
        source.consumer_id !== `registered:${assignment.actionId}` ||
        source.metadata.actionId !== assignment.actionId ||
        source.metadata.actionRunId !== assignment.actionRunId
      ) {
        refuse("Local Action source and target do not match.");
      }
      const rootKey = source.metadata.rootKey ?? assignment.actionRunId;
      text(rootKey);
      const parentActionRunId = source.metadata.parentActionRunId;
      if (parentActionRunId !== undefined) text(parentActionRunId);
      const metadata = json(source.metadata.actionMetadata);
      if (
        !metadata || typeof metadata !== "object" || Array.isArray(metadata)
      ) {
        throw new TypeError("Invalid immutable Action metadata.");
      }
      assignment = {
        ...assignment,
        invocation: {
          actionRunId: assignment.actionRunId,
          rootKey,
          operationKey: assignment.actionRunId,
          ...(parentActionRunId ? { parentActionRunId } : {}),
          metadata:
            metadata as RegisteredActionInvocation["invocation"]["metadata"],
          identity: {
            causationId: source.event_id,
            correlationId: source.correlation_id,
            settlementScopeId: source.settlement_scope_id,
            ...(source.action_scope_id
              ? { actionScopeId: source.action_scope_id }
              : {}),
          },
        },
      };
    }
    const scopes = await tx.query<
      { state: string; cancellation_requested_at: unknown }
    >(
      `SELECT state,cancellation_requested_at FROM ${operationTables.operations} WHERE namespace=$1 AND operation_id=$2${
        ownerAuthorityLock(readMode, " FOR UPDATE")
      }`,
      [assignment.namespace, source.settlement_scope_id],
    );
    const scope = scopes.rows[0];
    if (!scope || !["accepted", "running"].includes(scope.state)) {
      refuse("Execution scope is not live.");
    }
    const cancelled = scope.cancellation_requested_at != null;
    if (cancelled && mode !== "complete") {
      refuse("Execution scope was cancelled.");
    }
    await tx.query(
      `SELECT id FROM ${tables.event_deliveries} WHERE id=$1${
        ownerAuthorityLock(readMode, " FOR UPDATE")
      }`,
      [assignment.deliveryId],
    );
    const store = createEventStore({
      session: {
        query: tx.query.bind(tx),
        transaction() {
          throw new TypeError("Nested execution transactions are forbidden.");
        },
      },
      schema: options.schema,
    });
    const delivery = await store.getDelivery(assignment.deliveryId);
    if (
      !delivery || delivery.settlementScopeId !== source.settlement_scope_id
    ) refuse("Execution delivery changed.");
    const time = Date.parse(commandTime);
    const live = ownerAttemptIsLive(delivery, assignment);
    if (candidate) {
      if (
        delivery.status !== "pending" || delivery.attempts !== 0 ||
        delivery.attempts >= delivery.maxAttempts ||
        Date.parse(delivery.availableAt) > time
      ) {
        refuse("Local Action start requires an untouched fresh delivery.");
      }
    } else if (mode === "claim") {
      const eligible = delivery.attempts < delivery.maxAttempts &&
        (["pending", "retry_wait"].includes(delivery.status) &&
          Date.parse(delivery.availableAt) <= time);
      if (!eligible && !live) refuse("Execution delivery is not claimable.");
    } else if (!live) refuse("Execution attempt is no longer live.");
    if (
      assignment.placement === "owner-local" && !candidate &&
      delivery.attempts !== 1
    ) {
      refuse("Local Action historical recovery is not enabled.");
    }
    const terminal = await store.getEventByDeduplicationId(
      assignment.namespace,
      `${assignment.invocation.actionRunId}:action:terminal`,
    );
    if (terminal) refuse("Execution already has a terminal lifecycle.");
    const state: Authorized = {
      caller: structuredClone(caller),
      prepared: Object.hasOwn(source.metadata, OWNER_PREPARATION_METADATA),
      assignment,
      action,
      delivery,
      cancelled,
      correlationId: source.correlation_id,
      source: {
        id: source.event_id,
        ownerId: source.owner_id,
        namespace: source.namespace,
        correlationId: source.correlation_id,
      },
    };
    if (mode === "claim" || mode === "input" || mode === "mutation") {
      await guardPrepared(tx, state, commandTime, mode);
    }
    return state;
  }
  async function guardPrepared(
    tx: SqlExecutor,
    state: Authorized,
    commandTime: string,
    purpose: "claim" | "input" | "mutation",
    signal: AbortSignal = new AbortController().signal,
  ): Promise<void> {
    signal.throwIfAborted();
    if (!state.prepared) return;
    const store = createEventStore({
      schema: options.schema,
      session: {
        query: tx.query.bind(tx),
        transaction() {
          throw new Error("Prepared input reads cannot open transactions.");
        },
      },
    });
    const source = await store.getEvent(state.delivery.eventId);
    if (!source) refuse("Execution source event is unavailable.");
    const capture = preparationCaptureFromMetadata(source.metadata);
    if (!capture) return;
    const a = state.assignment;
    if (
      source.ownerId !== options.ownerId || source.namespace !== a.namespace ||
      source.type !== "copilotz.owner.action.requested" ||
      source.metadata.actionId !== a.actionId ||
      source.metadata.actionRunId !== a.invocation.actionRunId ||
      source.deduplicationId !== a.invocation.actionRunId ||
      state.delivery.consumerId !== `registered:${a.actionId}` ||
      capture.source.source.namespace !== a.namespace
    ) {
      refuse("Prepared input does not match its assigned child.");
    }
    if (!authorizePreparedInput) {
      refuse("Prepared input authority is unavailable.");
    }
    await authorizePreparedInput(tx, {
      caller: structuredClone(state.caller),
      sourceEventId: source.id,
      deliveryId: state.delivery.id,
      actionId: a.actionId,
      namespace: a.namespace,
      purpose,
      commandTime,
      signal: AbortSignal.any([signal]),
    });
    signal.throwIfAborted();
  }
  /** Re-resolve grants after policy awaits, then reread locked durable facts.
   * No input/preparation policy is called recursively. Runtime private lifetime
   * remains the host/driver's synchronous fence after these SQL awaits. */
  async function recheckAuthority(
    tx: SqlExecutor,
    state: Authorized,
    commandTime: string,
    grant: "ctx" | "settlement",
    captured: ActionInvokedData,
    readMode: OwnerAuthorityReadMode = "locking",
  ): Promise<{ cancelled: boolean }> {
    const found = await options.resolveAssignment(
      tx,
      structuredClone(state.caller),
      commandTime,
      readMode,
    );
    const current = found ? structuredClone(found) : undefined;
    if (
      !current || current.placement !== state.assignment.placement ||
      (grant === "ctx" ? current.ctxGranted : current.settlementGranted) !==
        true ||
      current.namespace !== state.assignment.namespace ||
      current.actionId !== state.assignment.actionId ||
      current.deliveryId !== state.assignment.deliveryId ||
      current.invocation.actionRunId !==
        state.assignment.invocation.actionRunId ||
      ownerAttemptToken(current) !== ownerAttemptToken(state.assignment)
    ) {
      refuse("Execution authority changed after policy.");
    }
    assertOwnerAttemptCaller(state.caller, current, options.ownerId);
    if (
      current.placement === "owner-local" &&
      (state.assignment.placement !== "owner-local" ||
        current.invocation.actionRunId !== current.actionRunId ||
        JSON.stringify(localBinding(current)) !==
          JSON.stringify(localBinding(state.assignment)))
    ) {
      refuse("Local execution binding changed after policy.");
    }
    const scope =
      (await tx.query<{ state: string; cancellation_requested_at: unknown }>(
        `SELECT state,cancellation_requested_at FROM ${operationTables.operations} WHERE namespace=$1 AND operation_id=$2${
          ownerAuthorityLock(readMode, " FOR UPDATE")
        }`,
        [current.namespace, state.delivery.settlementScopeId],
      )).rows[0];
    if (
      !scope || !["accepted", "running"].includes(scope.state) ||
      (grant === "ctx" && scope.cancellation_requested_at != null)
    ) {
      refuse("Execution scope authority changed after policy.");
    }
    const store = createEventStore({
      schema: options.schema,
      session: {
        query: tx.query.bind(tx),
        transaction() {
          throw new TypeError("Nested authority reads are forbidden.");
        },
      },
    });
    const delivery = await store.getDelivery(current.deliveryId);
    if (
      !delivery ||
      JSON.stringify(delivery) !== JSON.stringify(state.delivery) ||
      !ownerAttemptIsLive(delivery, current) ||
      await store.getEventByDeduplicationId(
        current.namespace,
        `${current.invocation.actionRunId}:action:terminal`,
      )
    ) {
      refuse("Execution durable attempt changed after policy.");
    }
    const currentCapture = await invoked(tx, state, readMode);
    if (
      !currentCapture ||
      JSON.stringify(json(currentCapture)) !== JSON.stringify(json(captured))
    ) {
      refuse("Execution captured input changed after policy.");
    }
    if (isCurrentAssignment) {
      let answer: unknown;
      try {
        answer = isCurrentAssignment(
          structuredClone(state.caller),
          structuredClone(current),
        );
        if (answer instanceof Promise) {
          Promise.prototype.then.call(answer, undefined, () => undefined);
        }
      } catch {
        refuse("Current private execution authority refused.");
      }
      if (answer !== true) {
        refuse("Current private execution authority refused.");
      }
    }
    return { cancelled: scope.cancellation_requested_at != null };
  }
  const inventory = (tx: SqlExecutor, state: Authorized) =>
    readOwnerEffectInventory(tx, {
      ownerId: options.ownerId,
      schema: options.schema,
      namespace: state.assignment.namespace,
      actionRunId: state.assignment.invocation.actionRunId,
    });
  const indeterminate = (): never => {
    throw Object.assign(new Error("External effect recovery is unresolved."), {
      code: "effect_indeterminate",
    });
  };
  async function recovery(
    tx: SqlExecutor,
    state: Authorized,
    commandTime: string,
  ): Promise<RegisteredExecutionRecovery | undefined> {
    const a = state.assignment;
    if (a.placement === "owner-local") {
      if (state.delivery.attempts !== 1) return indeterminate();
      return undefined;
    }
    const rows = await tx.query<
      {
        principal_kind: string;
        principal_id: string;
        kind: string;
        intent: unknown;
        result: unknown;
      }
    >(
      `SELECT principal_kind,principal_id,kind,intent,result FROM ${
        ownerTableNames(options.schema).receipts
      }
       WHERE owner=$1 AND domain='incarnation' AND key=$2`,
      [
        options.ownerId,
        ownerClaimKey(options.ownerId, a.assignmentId, a.sessionId),
      ],
    );
    const row = rows.rows[0];
    if (
      rows.rows.length !== 1 || row.kind !== "execution.claim" ||
      row.principal_kind !== "worker" ||
      row.principal_id !==
        ownerPrincipalIdentity({ kind: "worker", workerId: a.workerId }).id
    ) {
      refuse("Execution has no exact durable claim.");
    }
    const intent = object(row.intent, ["assignmentId", "sessionId"]);
    if (
      intent.assignmentId !== a.assignmentId || intent.sessionId !== a.sessionId
    ) {
      refuse("Execution claim binding changed.");
    }
    const captured = readExecutionClaim(row.result);
    checkReference(captured.reference, a);
    if (state.delivery.attempts > 1 && !captured.recovery) {
      return indeterminate();
    }
    if (state.delivery.attempts === 1 && captured.recovery) {
      return indeterminate();
    }
    if (!captured.recovery) return undefined;
    const permitted = captured.recovery.status === "eligible" &&
      await allowRecovery?.(
          tx,
          structuredClone(a),
          state.action.id,
          commandTime,
        ) === true;
    return { ...captured.recovery, status: permitted ? "eligible" : "blocked" };
  }
  async function recoveryBarrier(
    tx: SqlExecutor,
    state: Authorized,
    commandTime: string,
  ) {
    const captured = await recovery(tx, state, commandTime);
    if (!captured) return;
    if (captured.status !== "eligible") return indeterminate();
    const now = new Map(
      (await inventory(tx, state)).map((
        effect,
      ) => [effect.step, effect.status]),
    );
    for (const effect of captured.effects) {
      const status = now.get(effect.step);
      if (
        !status || status === "begun" ||
        (effect.status !== "begun" && status !== effect.status)
      ) return indeterminate();
    }
  }
  function requireAuthorized(tx: SqlExecutor): Authorized {
    const result = authorized.get(tx);
    if (!result) refuse("Execution handler requires boundary authorization.");
    return result;
  }
  function runtime(context: OwnerCommandContext) {
    const ownerCommit = ownerEventCommitForAttempt(
      context,
      requireAuthorized(context.tx).assignment,
    );
    const scheduled = new Set<string>();
    const schedule = async (operationId: string) => {
      if (!options.scheduleSettlement || scheduled.has(operationId)) return;
      const namespace = requireAuthorized(context.tx).assignment.namespace;
      await options.scheduleSettlement(context, { namespace, operationId });
      scheduled.add(operationId);
    };
    const ownerStoreOptions: CreateEventStoreOptions = {
      session: options.session,
      schema: options.schema,
      lockSettlementScope: (tx, scope) => options.catalog.lockScope(tx, scope),
      assertOperationCatalog: options.catalog.assertFormat,
      admitOperationEventSql: (input, param) =>
        options.catalog.admitEventSql(input, param),
      indexOperationEvent: (tx, input) => options.catalog.indexEvent(tx, input),
      indexOperationEventSql: (input, param) =>
        options.catalog.indexEventSql(input, param),
    };
    const coordinatorFor = (store: EventStore) =>
      createEventCoordinator({
        store,
        registry: options.registry,
        executor: options.executor,
        publish: options.publish,
        scheduleOnly: true,
      });
    const store: EventStore = createEventStore({
      ...ownerStoreOptions,
      ownerCommit,
      settleActionOwners: async (tx, delivery) => {
        // Settlement has already made this delivery terminal in the same owner
        // transaction. Its abandoned obligations use the existing recovery
        // writer, not an expired live-attempt capability. Keep that owner-control
        // view private to this callback; never weaken the normal attempt store.
        const settledStore = createEventStore({
          ...ownerStoreOptions,
          ownerCommit: {
            ...context.ownerCommit,
            transaction: tx,
            afterCommit: context.afterCommit,
          },
        });
        const publish = await recoverDeliveryActions(
          {
            store: settledStore,
            coordinator: coordinatorFor(settledStore),
            catalog: options.catalog,
            actions: options.registry.actions,
            commandTime: context.commandTime,
            async hasUnresolvedEffect(transaction, ref) {
              return (await readOwnerEffectInventory(transaction, {
                ...ref,
                ownerId: options.ownerId,
                schema: options.schema,
              })).some((effect) => effect.status === "begun");
            },
          },
          tx,
          delivery,
        );
        await schedule(delivery.settlementScopeId);
        return publish;
      },
    });
    const coordinator = coordinatorFor(store);
    const lifecycle = (state: Authorized, cancellation = false) => {
      const append = createActionLifecycleAppender({
        store,
        coordinator,
        actions: options.registry.actions,
        transaction: context.tx,
        commandTime: context.commandTime,
        ownerAuthority: ownerCommit,
        schema: options.schema,
        writer: cancellation
          ? {
            kind: "cancellation",
            namespace: state.assignment.namespace,
            operationId: state.delivery.settlementScopeId,
          }
          : {
            kind: "owner-attempt",
            deliveryId: state.delivery.id,
            attemptId: ownerAttemptToken(state.assignment),
          },
      });
      return createActionLifecycleEmitter({
        namespace: state.assignment.namespace,
        metadata: { sourceDeliveryId: state.delivery.id },
        append: async (input) => {
          // Scope cancellation retains its special writer/admission semantics,
          // while the local EventStore independently requires this exact tuple.
          {
            const existing = input.draft.deliveryLease;
            if (
              existing &&
              (existing.deliveryId !== state.assignment.deliveryId ||
                existing.owner !== ownerAttemptToken(state.assignment))
            ) {
              refuse("Lifecycle delivery authority differs.");
            }
            if (!existing) {
              input = {
                ...input,
                draft: {
                  ...input.draft,
                  deliveryLease: {
                    deliveryId: state.assignment.deliveryId,
                    owner: ownerAttemptToken(state.assignment),
                  },
                },
              };
            }
          }
          const result = await append(input);
          context.afterCommit(async () => {
            await coordinator.flushCommitted(result);
          });
          return result;
        },
      });
    };
    return { store, lifecycle, schedule };
  }
  async function invoked(
    tx: SqlExecutor,
    state: Authorized,
    readMode: OwnerAuthorityReadMode = "locking",
  ): Promise<ActionInvokedData | null> {
    const store = createEventStore({
      session: {
        query: tx.query.bind(tx),
        transaction() {
          throw new TypeError("Nested execution transactions are forbidden.");
        },
      },
      schema: options.schema,
    });
    const data = await createActionLifecycleLoader({
      store,
      actions: options.registry.actions,
    })(
      state.assignment.namespace,
      `${state.assignment.invocation.actionRunId}:action:invoked`,
    );
    if (!data) return null;
    if (
      data.status !== "invoked" ||
      data.actionId !== state.assignment.actionId ||
      data.actionRunId !== state.assignment.invocation.actionRunId
    ) refuse("Captured execution input does not match.");
    json(data);
    const open = await tx.query<
      { action_id: string; owner_delivery_id: string; state: string }
    >(
      `SELECT action_id,owner_delivery_id,state FROM ${tables.open_actions} WHERE namespace=$1 AND action_run_id=$2${
        ownerAuthorityLock(readMode, " FOR UPDATE")
      }`,
      [state.assignment.namespace, state.assignment.invocation.actionRunId],
    );
    if (
      open.rows.length !== 1 || open.rows[0].state !== "invoked" ||
      open.rows[0].action_id !== data.actionId ||
      open.rows[0].owner_delivery_id !== state.delivery.id
    ) {
      refuse("Execution does not own the captured Action obligation.");
    }
    return data;
  }
  async function prepareClaimInput(
    tx: SqlExecutor,
    state: Authorized,
    commandTime: string,
    signal: AbortSignal,
    captured: ActionInvokedData | null,
  ) {
    if (state.assignment.placement === "owner-local" && captured) {
      refuse("Local Action start cannot reuse an invoked capture.");
    }
    let input: OwnerJson;
    if (captured) input = json(captured.input);
    else {
      const event = await createEventStore({
        schema: options.schema,
        session: {
          query: tx.query.bind(tx),
          transaction() {
            throw new Error("Nested input reads are forbidden.");
          },
        },
      }).getEvent(state.delivery.eventId);
      if (!event || event.namespace !== state.assignment.namespace) {
        refuse("Execution source event is unavailable.");
      }
      input = json(
        await readEventBody(
          { transaction: tx, tables },
          event.namespace,
          eventDataRef(event.payload),
        ),
      );
    }
    await options.authorizeInput(
      tx,
      structuredClone(state.assignment),
      json(input),
      commandTime,
    );
    if (state.action.inputSchema) {
      validateAgainstJsonSchema(
        state.action.inputSchema,
        input,
        "Action input",
      );
    }
    await guardPrepared(
      tx,
      state,
      commandTime,
      "claim",
      signal,
    );
    return { captured, input };
  }
  const claim: OwnerCommandHandler = async (_intent, context) => {
    const state = requireAuthorized(context.tx);
    const { store, lifecycle, schedule } = runtime(context);
    const captured = await invoked(context.tx, state);
    const acquire = async () => {
      const delivery = await store.claimDelivery({
        id: state.delivery.id,
        owner: ownerAttemptToken(state.assignment),
      });
      // A receiptless live attempt is never a new execution entitlement.
      if (!delivery) refuse("Execution claim did not acquire a fresh attempt.");
      return delivery;
    };
    // Preserve worker policy's established transaction view: claim first, then
    // hydrate and authorize input. Local start checks policy before any writes.
    let delivery = state.assignment.placement === "worker"
      ? await acquire()
      : undefined;
    const { input } = await prepareClaimInput(
      context.tx,
      state,
      context.commandTime,
      context.signal,
      captured,
    );
    if (state.assignment.placement === "owner-local") {
      await authorizeStart(
        context.tx,
        context.caller,
        localBinding(state.assignment),
        context.commandTime,
      );
      await local!.reserveLocal(context, localBinding(state.assignment));
      delivery = await acquire();
    }
    if (!delivery) refuse("Execution claim did not acquire a fresh attempt.");
    if (!captured) {
      await lifecycle(state).emit({
        ...state.assignment.invocation,
        actionId: state.assignment.actionId,
        input,
        status: "invoked",
        causationId: delivery.eventId,
        correlationId: state.correlationId,
        settlementScopeId: delivery.settlementScopeId,
        actionScopeId: delivery.actionScopeId,
        deduplicationId:
          `${state.assignment.invocation.actionRunId}:action:invoked`,
      });
    }
    await schedule(delivery.settlementScopeId);
    if (state.assignment.placement === "owner-local") {
      return json({
        binding: localBinding(state.assignment),
        attempts: delivery.attempts,
      });
    }
    const permitted = await allowRecovery?.(
      context.tx,
      structuredClone(state.assignment),
      state.action.id,
      context.commandTime,
    ) === true;
    const original = delivery.attempts > 1
      ? await readOwnerOriginalExecutionContract(context.tx, {
        ownerId: context.ownerCommit.ownerId,
        schema: options.schema,
        epoch: context.ownerCommit.epoch,
        namespace: state.assignment.namespace,
        actionId: state.action.id,
        actionRunId: state.assignment.invocation.actionRunId,
        sourceEventId: delivery.eventId,
        deliveryId: delivery.id,
      })
      : undefined;
    const recovery: RegisteredExecutionRecovery | undefined =
      delivery.attempts > 1
        ? {
          status: original && permitted ? "eligible" : "blocked",
          effects: await inventory(context.tx, state),
        }
        : undefined;
    // Only the original fresh claim can attest its own execution contract.
    // A new deployment, duplicate, retry, or absence of effects cannot create
    // evidence about code which already ran under an older assignment.
    const contract: RegisteredExecutionContract | undefined =
      delivery.attempts === 1 && !captured && permitted
        ? {
          protocol: OWNER_EFFECT_EXECUTION_CONTRACT,
          attempt: 1,
          ownerEpoch: context.ownerCommit.epoch,
          ownerId: context.ownerCommit.ownerId,
          namespace: state.assignment.namespace,
          actionId: state.action.id,
          actionRunId: state.assignment.invocation.actionRunId,
          sourceEventId: delivery.eventId,
          deliveryId: delivery.id,
          workerId: state.assignment.workerId,
          assignmentId: state.assignment.assignmentId,
          sessionId: state.assignment.sessionId,
          dispatchAttemptId: state.assignment.dispatchAttemptId,
        }
        : undefined;
    return json({
      ...reference(state.assignment),
      ...(recovery ? { recovery } : {}),
      ...(contract ? { contract } : {}),
    });
  };
  const complete: OwnerCommandHandler = async (_intent, context) => {
    const state = requireAuthorized(context.tx);
    const value = object(context.input, [
      "namespace",
      "executionId",
      "completion",
    ]);
    const data = completion(value.completion);
    const captured = await invoked(context.tx, state);
    if (!captured) refuse("Execution has no captured invocation.");
    if (data.status === "completed") {
      await recoveryBarrier(context.tx, state, context.commandTime);
      if (
        (await inventory(context.tx, state)).some((effect) =>
          effect.status === "begun"
        )
      ) {
        return indeterminate();
      }
    }
    if (data.status === "completed" && state.action.outputSchema) {
      validateAgainstJsonSchema(
        state.action.outputSchema,
        data.output,
        "Action output",
      );
    }
    const { store, lifecycle } = runtime(context);
    await lifecycle(state, state.cancelled && data.status === "cancelled").emit(
      {
        ...captured,
        ...(data.status === "completed"
          ? { status: "completed", output: data.output }
          : {
            status: data.status,
            error: {
              name: data.status === "cancelled"
                ? "AbortError"
                : "ActionExecutionFailed",
              message: data.code,
              code: data.code,
            },
          }),
        causationId: state.delivery.eventId,
        correlationId: state.correlationId,
        settlementScopeId: state.delivery.settlementScopeId,
        actionScopeId: state.delivery.actionScopeId,
        deduplicationId:
          `${state.assignment.invocation.actionRunId}:action:terminal`,
      },
    );
    const settled = data.status === "completed"
      ? await store.succeedDelivery(
        state.delivery.id,
        ownerAttemptToken(state.assignment),
      )
      : data.status === "cancelled"
      ? await store.cancelDelivery(
        state.delivery.id,
        ownerAttemptToken(state.assignment),
      )
      : await store.failDelivery({
        id: state.delivery.id,
        owner: ownerAttemptToken(state.assignment),
        error: { name: "ActionExecutionFailed", message: data.code },
        retryable: false,
      });
    if (!settled) refuse("Execution settlement lost its attempt.");
    if (state.assignment.placement === "owner-local") {
      await local!.retireLocal(context, localBinding(state.assignment));
    }
    return json({ ...reference(state.assignment), status: data.status });
  };
  const project: OwnerProjectionHandler = async (_input, context) => {
    const state = requireAuthorized(context.tx);
    const captured = await invoked(context.tx, state);
    if (!captured) refuse("Execution has no captured invocation.");
    const input = json(captured.input);
    await options.authorizeInput(
      context.tx,
      structuredClone(state.assignment),
      json(input),
      context.commandTime,
    );
    const barrier = await recovery(context.tx, state, context.commandTime);
    await guardPrepared(
      context.tx,
      state,
      context.commandTime,
      "input",
      context.signal,
    );
    await recheckAuthority(
      context.tx,
      state,
      context.commandTime,
      "ctx",
      captured,
    );
    return json({
      ...(barrier ? { recovery: barrier } : {}),
      actionId: captured.actionId,
      ...(state.assignment.placement === "worker"
        ? {
          workerId: state.assignment.workerId,
        }
        : { reference: localBinding(state.assignment) }),
      input,
      namespace: state.assignment.namespace,
      databaseSchema: options.schema,
      ownerId: options.ownerId,
      invocation: {
        ...state.assignment.invocation,
        metadata: captured.metadata,
        ...(captured.parentActionRunId
          ? { parentActionRunId: captured.parentActionRunId }
          : {}),
      },
    });
  };
  /** Current settlement facts only. Never hydrates input or reads a terminal
   * receipt, and never grants recovery or permission to invoke again. */
  const localSettlementState: OwnerProjectionHandler = async (
    _input,
    context,
  ) => {
    const state = requireAuthorized(context.tx);
    if (state.assignment.placement !== "owner-local") {
      refuse("Local settlement state requires a local Action attempt.");
    }
    const captured = await invoked(context.tx, state);
    if (!captured) {
      refuse("Execution has no captured invocation.");
    }
    const checked = await recheckAuthority(
      context.tx,
      state,
      context.commandTime,
      "settlement",
      captured,
    );
    return json({
      reference: localBinding(state.assignment),
      cancellationRequested: checked.cancelled,
    });
  };
  async function authorizeLocalStart(
    tx: SqlExecutor,
    caller: OwnerCaller,
    binding: OwnerLocalActionAssignmentBinding,
    commandTime: string,
  ): Promise<void> {
    // Fail-closed duplicates are deliberate: this minimal receipt is neither
    // permission to execute twice nor a historical recovery contract. A driver
    // must stop on an unknown start outcome, pending a separate reconciliation.
    const value = parseOwnerPlacementBinding(binding);
    if (value.placement !== "owner-local" || value.kind !== "action") {
      throw new TypeError("Local Action binding required.");
    }
    const state = await current(tx, caller, commandTime, "claim", value);
    // Boundary authorization has no request signal. The real boundary checks
    // pending cancellation before the handler; this read-only policy must settle
    // first, retaining its command/capacity occupancy rather than detaching work.
    await prepareClaimInput(
      tx,
      state,
      commandTime,
      new AbortController().signal,
      await invoked(tx, state),
    );
    await authorizeStart(tx, caller, value, commandTime);
    authorized.set(tx, state);
    localStarts.set(tx, { state, time: commandTime });
  }
  async function startLocal(
    binding: OwnerLocalActionAssignmentBinding,
    context: OwnerCommandContext,
  ): Promise<OwnerJson> {
    const value = parseOwnerPlacementBinding(binding);
    const ready = localStarts.get(context.tx);
    localStarts.delete(context.tx);
    if (
      value.placement !== "owner-local" || value.kind !== "action" || !ready ||
      ready.time !== context.commandTime ||
      ready.state !== authorized.get(context.tx) ||
      ready.state.assignment.placement !== "owner-local" ||
      JSON.stringify(value) !==
        JSON.stringify(localBinding(ready.state.assignment)) ||
      context.command.kind !== "owner.local-start" ||
      context.command.domain !== "incarnation" ||
      context.command.key !== ownerLocalActionStartKey(value)
    ) {
      refuse("Local start requires matching command-local authorization.");
    }
    ownerEventCommitForAttempt(context, ready.state.assignment);
    return await claim(value, context);
  }
  async function authorizeSettlementFacts(
    tx: SqlExecutor,
    caller: OwnerCaller,
    commandTime: string,
  ) {
    const state = await current(tx, caller, commandTime, "complete");
    const captured = await invoked(tx, state);
    if (!captured) {
      refuse("Execution has no captured invocation.");
    }
    await recheckAuthority(tx, state, commandTime, "settlement", captured);
    return {
      assignment: state.assignment,
      delivery: state.delivery,
      source: state.source,
    };
  }
  async function authorizeLiveFacts(
    tx: SqlExecutor,
    caller: OwnerCaller,
    commandTime: string,
    readMode: OwnerAuthorityReadMode = "locking",
  ): Promise<Pick<Authorized, "assignment" | "delivery" | "source">> {
    const state = await current(
      tx,
      caller,
      commandTime,
      "mutation",
      undefined,
      readMode,
    );
    const captured = await invoked(tx, state, readMode);
    if (!captured) refuse("Execution has no captured invocation.");
    await options.authorizeInput(
      tx,
      structuredClone(state.assignment),
      json(captured.input),
      commandTime,
    );
    await recoveryBarrier(tx, state, commandTime);
    await guardPrepared(tx, state, commandTime, "mutation");
    await recheckAuthority(tx, state, commandTime, "ctx", captured, readMode);
    return {
      assignment: state.assignment,
      delivery: state.delivery,
      source: state.source,
    };
  }

  return {
    inputDefinitions: { "execution.complete": completionInput },
    authorizeLocalStart,
    startLocal,
    handlers: {
      "owner.local-start": (binding, context) =>
        startLocal(binding as OwnerLocalActionAssignmentBinding, context),
      "execution.claim": claim,
      "execution.complete": complete,
    },
    projections: {
      "execution.input": project,
      "execution.local-settlement-state": localSettlementState,
    },
    async authorize(
      tx,
      caller,
      command,
      commandTime,
      normalizedInput?: OwnerJson,
    ) {
      if (command.kind === "owner.local-start") {
        const value = parseOwnerPlacementBinding(command.intent);
        if (
          value.placement !== "owner-local" || value.kind !== "action" ||
          command.domain !== "incarnation" ||
          command.key !== ownerLocalActionStartKey(value)
        ) {
          refuse("Local start command identity does not match.");
        }
        await authorizeLocalStart(tx, caller, value, commandTime);
        return;
      }
      const mode = command.kind === "execution.claim"
        ? "claim"
        : command.kind === "execution.complete"
        ? "complete"
        : command.kind === "execution.local-settlement-state"
        ? "complete"
        : command.kind === "execution.input"
        ? "input"
        : undefined;
      if (!mode) throw new TypeError("Unknown execution command.");
      const state = await current(tx, caller, commandTime, mode);
      const a = state.assignment;
      if (command.kind === "execution.local-settlement-state") {
        if (a.placement !== "owner-local" || command.domain !== "occurrence") {
          refuse("Local settlement state requires a current local projection.");
        }
        checkReference(command.intent, a);
        authorized.set(tx, state);
        return;
      }
      if (mode === "claim") {
        if (a.placement !== "worker") {
          refuse("Worker claim requires worker placement.");
        }
        const data = object(command.intent, ["assignmentId", "sessionId"]);
        if (
          command.domain !== "incarnation" ||
          command.key !==
            ownerClaimKey(options.ownerId, a.assignmentId, a.sessionId) ||
          data.assignmentId !== a.assignmentId || data.sessionId !== a.sessionId
        ) refuse("Claim identity is not assigned.");
      } else if (mode === "complete") {
        const data = object(normalizedInput, [
          "namespace",
          "executionId",
          "completion",
        ]);
        if (
          command.domain !== "logical" ||
          command.key !==
            ownerCompletionKey(
              options.ownerId,
              a.namespace,
              a.invocation.actionRunId,
            ) ||
          data.namespace !== a.namespace ||
          data.executionId !== a.invocation.actionRunId
        ) refuse("Completion identity is not assigned.");
        const result = completion(data.completion);
        if (state.cancelled && result.status !== "cancelled") {
          refuse("Scope cancellation takes precedence over completion.");
        }
        if (result.status === "completed") {
          await recoveryBarrier(tx, state, commandTime);
          if (
            (await inventory(tx, state)).some((effect) =>
              effect.status === "begun"
            )
          ) {
            return indeterminate();
          }
        }
        if (result.status === "completed" && state.action.outputSchema) {
          validateAgainstJsonSchema(
            state.action.outputSchema,
            result.output,
            "Action output",
          );
        }
      } else checkReference(command.intent, a);
      authorized.set(tx, state);
    },
    authorizeSettlementFacts,
    async authorizeSettlement(tx, caller, commandTime) {
      return (await authorizeSettlementFacts(tx, caller, commandTime))
        .assignment;
    },
    authorizeLiveFacts,
    async authorizeLive(tx, caller, commandTime, readMode = "locking") {
      return (await authorizeLiveFacts(tx, caller, commandTime, readMode))
        .assignment;
    },
  };
}
