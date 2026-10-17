/** Private durable Processor commands. Delivery bookkeeping is not an Action
 * invocation: no synthetic Action frame, open_action or terminal is created. */
import { isContentRef } from "../content/schema.ts";
import { eventDataRef, readEventBody } from "../events/body-store.ts";
import {
  createCoreTableNames,
  quoteEventIdentifier,
} from "../events/schema.ts";
import type { SqlExecutor, SqlSession } from "../events/session.ts";
import { createEventStore } from "../events/store.ts";
import type { DurableEvent, EventDelivery } from "../events/types.ts";
import {
  ownerProcessorClaimKey,
  ownerProcessorCompletionKey,
  ownerProcessorOperationKey,
  type RegisteredProcessorCompletion,
  type RegisteredProcessorReference,
} from "../execution/registered-processor.ts";
import type { RegisteredProcessorInvocation } from "../execution/registered-invocation.ts";
import { ownerAssignmentKey } from "./assignments.ts";
import {
  assertOwnerAttemptCaller,
  ownerAssignmentFacts,
  ownerAttemptIsLive,
  ownerEventCommitForAttempt,
} from "./attempt-authority.ts";
import { assertOwnerOrdinaryValue } from "./ordinary-value.ts";
import {
  type OwnerLocalProcessorAssignmentBinding,
  parseOwnerPlacementBinding,
} from "./placement-binding.ts";
import { ownerPrincipalIdentity } from "./principal.ts";
import { ownerTableNames } from "./schema.ts";
import { assertJsonValue } from "../json.ts";
import { matchDataFromPayload, matchProcessor } from "../plugins/match.ts";
import type { Processor } from "../plugins/processor.ts";
import { processorConsumerId } from "../plugins/processor.ts";
import type { PluginRegistry } from "../plugins/registry.ts";
import {
  createOperationCatalogTables,
  type OperationCatalog,
  type OperationSettlementScope,
} from "../streams/catalog.ts";
import type {
  OwnerCaller,
  OwnerCommand,
  OwnerCommandContext,
  OwnerCommandHandler,
  OwnerJson,
  OwnerProjectionHandler,
} from "./boundary.ts";

/** Host-owned Started binding. The resolver must validate the current transport
 * session and assignment, never reconstruct authority from command arguments. */
export type OwnerProcessorAssignment = Readonly<{
  kind: "processor";
  ownerId: string;
  workerId: string;
  assignmentId: string;
  sessionId: string;
  namespace: string;
  processorId: string;
  sourceEventId: string;
  deliveryId: string;
  dispatchAttemptId: string;
  ctxGranted: boolean;
  settlementGranted: boolean;
}>;
/** Private local facts. The resolver must check the live private handle and the
 * exact current durable reservation; this value alone grants no authority. */
export type OwnerLocalProcessorAssignment =
  & OwnerLocalProcessorAssignmentBinding
  & Readonly<{
    ctxGranted: boolean;
    settlementGranted: boolean;
    attemptOrdinal: number;
  }>;
export type OwnerLocalProcessorProjection =
  & RegisteredProcessorInvocation
  & Readonly<{ reference: OwnerLocalProcessorAssignmentBinding }>;
export type OwnerLocalProcessorStartFacts = Readonly<{
  status: "pending" | "retry_wait";
  attempts: number;
  maxAttempts: number;
  availableAt: string;
}>;
export type OwnerLocalProcessorStartReceipt = Readonly<{
  binding: OwnerLocalProcessorAssignmentBinding;
  attempts: number;
}>;
export type OwnerLocalProcessorAttemptReceipt =
  | Readonly<{
    reference: OwnerLocalProcessorAssignmentBinding;
    attempts: number;
    status: "succeeded" | "dead_letter" | "cancelled";
  }>
  | Readonly<{
    reference: OwnerLocalProcessorAssignmentBinding;
    attempts: number;
    status: "retry_wait";
    availableAt: string;
  }>;
export type OwnerLocalProcessorSettlementState = Readonly<{
  reference: OwnerLocalProcessorAssignmentBinding;
  cancellationRequested: boolean;
}>;
type LocalPhase = "start" | "ctx" | "settlement";
export type OwnerLocalProcessorOptions = Readonly<{
  resolveAssignment(tx: SqlExecutor, caller: OwnerCaller, time: string):
    | OwnerLocalProcessorAssignment
    | undefined
    | Promise<OwnerLocalProcessorAssignment | undefined>;
  /** Current private control/capacity and input authority. A successor requires
   * the same live owner's known retry_wait, revoked predecessor and true drain.
   * SQL facts, a due alarm or a retained receipt cannot establish that proof. */
  authorizeStart(
    tx: SqlExecutor,
    caller: OwnerCaller,
    binding: OwnerLocalProcessorAssignmentBinding,
    facts: OwnerLocalProcessorStartFacts,
    time: string,
  ):
    | Readonly<{ attemptOrdinal: number }>
    | undefined
    | Promise<Readonly<{ attemptOrdinal: number }> | undefined>;
  authorizeEvent(
    tx: SqlExecutor,
    assignment: OwnerLocalProcessorAssignment,
    event: DurableEvent,
    data: OwnerJson,
    time: string,
  ): void | Promise<void>;
  /** Synchronous genuine private-handle/grant witness after the last await.
   * Never infer authority from these detached arguments. Only true admits. */
  isCurrent(
    caller: OwnerCaller,
    binding: OwnerLocalProcessorAssignmentBinding,
    attemptOrdinal: number,
    phase: LocalPhase,
  ): boolean;
  /** Transactional bookkeeping only, never activation or capacity release. */
  reserveLocal(
    context: OwnerCommandContext,
    binding: OwnerLocalProcessorAssignmentBinding,
  ): Promise<void>;
  retireLocal(
    context: OwnerCommandContext,
    binding: OwnerLocalProcessorAssignmentBinding,
  ): Promise<void>;
}>;
const localBindingFields = [
  "placement",
  "ownerId",
  "epoch",
  "holderId",
  "attemptId",
  "namespace",
  "sourceEventId",
  "deliveryId",
  "kind",
  "processorId",
  "consumerId",
] as const;
function localOwn(value: unknown, fields: readonly string[]) {
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).length !== fields.length
  ) throw new TypeError("Closed local Processor own-data fields required.");
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError("Local Processor accessors are forbidden.");
    }
    result[field] = descriptor.value;
  }
  return result;
}
function localBinding(value: unknown): OwnerLocalProcessorAssignmentBinding {
  const binding = parseOwnerPlacementBinding(
    localOwn(value, localBindingFields),
  );
  if (binding.placement !== "owner-local" || binding.kind !== "processor") {
    throw new TypeError("Local Processor binding required.");
  }
  return binding;
}
function localAssignment(value: unknown): OwnerLocalProcessorAssignment {
  const data = localOwn(value, [
    ...localBindingFields,
    "ctxGranted",
    "settlementGranted",
    "attemptOrdinal",
  ]);
  const binding = localBinding(Object.fromEntries(
    localBindingFields.map((key) => [key, data[key]]),
  ));
  if (
    typeof data.ctxGranted !== "boolean" ||
    typeof data.settlementGranted !== "boolean" ||
    !Number.isSafeInteger(data.attemptOrdinal) ||
    Number(data.attemptOrdinal) < 1
  ) throw new TypeError("Invalid local Processor grants or ordinal.");
  return {
    ...binding,
    ctxGranted: data.ctxGranted,
    settlementGranted: data.settlementGranted,
    attemptOrdinal: Number(data.attemptOrdinal),
  };
}
function bindingOf(value: OwnerLocalProcessorAssignment) {
  return localBinding(Object.fromEntries(
    localBindingFields.map((key) => [key, value[key]]),
  ));
}
function localKey(kind: string, value: OwnerLocalProcessorAssignmentBinding) {
  const b = localBinding(value);
  return JSON.stringify([
    kind,
    1,
    b.ownerId,
    b.epoch,
    b.holderId,
    b.deliveryId,
    b.attemptId,
  ]);
}
export const ownerLocalProcessorStartKey = (
  binding: OwnerLocalProcessorAssignmentBinding,
): string => localKey("owner.local-processor-start", binding);
export const ownerLocalProcessorCompletionKey = (
  binding: OwnerLocalProcessorAssignmentBinding,
): string => localKey("processor.local-complete", binding);
function captureLocal(options: object): OwnerLocalProcessorOptions | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(options, "local");
  if (!descriptor) return undefined;
  if (!descriptor.enumerable || !("value" in descriptor)) {
    throw new TypeError(
      "Local Processor options require an own data property.",
    );
  }
  const value = localOwn(descriptor.value, [
    "resolveAssignment",
    "authorizeStart",
    "authorizeEvent",
    "isCurrent",
    "reserveLocal",
    "retireLocal",
  ]);
  if (Object.values(value).some((callback) => typeof callback !== "function")) {
    throw new TypeError("Local Processor callbacks are required.");
  }
  return value as OwnerLocalProcessorOptions;
}

type Authorized = Readonly<{
  assignment: OwnerProcessorAssignment;
  processor: Processor;
  delivery: EventDelivery;
  event: DurableEvent;
  cancelled: boolean;
}>;
function refuse(message: string): never {
  throw Object.assign(new Error(message), {
    name: "ActionOwnershipLost",
    code: "ActionOwnershipLost",
  });
}
function json(value: unknown): OwnerJson {
  assertJsonValue(value, {
    maxDepth: 64,
    maxNodes: 100_000,
    rejectNegativeZero: true,
  });
  if (new TextEncoder().encode(JSON.stringify(value)).length > 1024 * 1024) {
    throw new TypeError("Processor data exceeds its limit.");
  }
  return structuredClone(value) as OwnerJson;
}
function object(value: unknown, keys: readonly string[]) {
  json(value);
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new TypeError("Invalid Processor command data.");
  }
  return value as Record<string, unknown>;
}
function text(value: unknown): asserts value is string {
  if (
    typeof value !== "string" || !value.trim() || value !== value.trim() ||
    value.length > 1024
  ) throw new TypeError("Invalid Processor identity.");
}
function ordinary(value: unknown): void {
  if (!value || typeof value !== "object") return;
  const schema = (value as { schema?: unknown }).schema;
  if (
    isContentRef(value) || [
      "copilotz.event.protected-value.v1",
      "copilotz.action.lifecycle.protected.v1",
      "copilotz.action.protected-value.v1",
    ].includes(String(schema))
  ) {
    throw new TypeError(
      "Processor content and protected data are unsupported.",
    );
  }
  for (const item of Object.values(value)) ordinary(item);
}
function reference(a: OwnerProcessorAssignment): RegisteredProcessorReference {
  return { deliveryId: a.deliveryId, dispatchAttemptId: a.dispatchAttemptId };
}
function checkReference(value: unknown, a: OwnerProcessorAssignment) {
  const data = object(value, ["deliveryId", "dispatchAttemptId"]);
  if (
    data.deliveryId !== a.deliveryId ||
    data.dispatchAttemptId !== a.dispatchAttemptId
  ) {
    refuse("Processor reference is not the current assignment.");
  }
}
function completion(value: unknown): RegisteredProcessorCompletion {
  const status = (value as { status?: unknown } | null)?.status;
  const data = object(
    value,
    status === "succeeded"
      ? ["status"]
      : status === "cancelled"
      ? ["status", "code"]
      : ["status", "code", "retryable"],
  );
  if (status === "succeeded") return { status };
  if (status === "cancelled" && data.code === "processor_cancelled") {
    return { status, code: data.code };
  }
  if (
    status !== "failed" || typeof data.code !== "string" ||
    typeof data.retryable !== "boolean" ||
    !["processor_failed", "processor_capability_unsupported"].includes(
      data.code,
    ) ||
    (data.code === "processor_capability_unsupported" && data.retryable)
  ) {
    throw new TypeError("Invalid safe Processor failure.");
  }
  return { status, code: data.code, retryable: data.retryable };
}

export function createOwnerProcessorCommands(
  options: Readonly<{
    ownerId: string;
    schema: string;
    session: SqlSession;
    registry: PluginRegistry;
    catalog: OperationCatalog;
    /** Internal local capability only; absent means all local routes refuse. */
    local?: OwnerLocalProcessorOptions;
    resolveAssignment(
      tx: SqlExecutor,
      caller: OwnerCaller,
      commandTime: string,
    ):
      | OwnerProcessorAssignment
      | undefined
      | Promise<OwnerProcessorAssignment | undefined>;
    /** Current SQL-only policy on the complete ordinary event and body. */
    authorizeEvent(
      tx: SqlExecutor,
      assignment: OwnerProcessorAssignment,
      event: DurableEvent,
      data: OwnerJson,
      commandTime: string,
    ): void | Promise<void>;
    /** Joins this command; dependent execution can only enqueue after COMMIT. */
    scheduleSettlement(
      context: OwnerCommandContext,
      scope: OperationSettlementScope,
    ): void | Promise<void>;
    /** Persist a retry wake using the actual committed availableAt. No dispatch in
     * the command. The scheduler is responsible for durable alarm recovery. */
    scheduleRetry(
      context: OwnerCommandContext,
      delivery: EventDelivery,
    ): void | Promise<void>;
  }>,
) {
  const local = captureLocal(options);
  text(options.ownerId);
  if (options.catalog.databaseSchema !== options.schema) {
    throw new TypeError("Processor catalog schema does not match.");
  }

  const tables = createCoreTableNames(options.schema);
  const operationTables = createOperationCatalogTables(options.schema);
  const authorized = new WeakMap<SqlExecutor, Authorized>();
  const readStore = (tx: SqlExecutor) =>
    createEventStore({
      schema: options.schema,
      session: {
        query: tx.query.bind(tx),
        transaction() {
          throw new TypeError("Nested Processor transactions are forbidden.");
        },
      },
    });
  const runtime = (
    context: OwnerCommandContext,
    binding?: OwnerLocalProcessorAssignmentBinding,
  ) =>
    createEventStore({
      session: options.session,
      schema: options.schema,
      ownerCommit: binding
        ? ownerEventCommitForAttempt(context, binding)
        : ownerEventCommitForAttempt(context, {
          placement: "worker",
          ...bound(context.tx).assignment,
        }),
      lockSettlementScope: (tx, scope) => options.catalog.lockScope(tx, scope),
      admitOperationEventSql: (input, param) =>
        options.catalog.admitEventSql(input, param),
      indexOperationEvent: (tx, input) => options.catalog.indexEvent(tx, input),
      indexOperationEventSql: (input, param) =>
        options.catalog.indexEventSql(input, param),
    });
  async function current(
    tx: SqlExecutor,
    caller: OwnerCaller,
    commandTime: string,
    mode: "claim" | "input" | "complete" | "mutation",
  ) {
    const found = await options.resolveAssignment(tx, caller, commandTime);
    if (!found) refuse("Processor assignment is no longer current.");
    const a = structuredClone(found);
    for (
      const key of [
        "ownerId",
        "workerId",
        "assignmentId",
        "sessionId",
        "namespace",
        "processorId",
        "sourceEventId",
        "deliveryId",
        "dispatchAttemptId",
      ] as const
    ) text(a[key]);
    if (
      a.kind !== "processor" || a.ownerId !== options.ownerId ||
      caller.principal.kind !== "worker" ||
      a.workerId !== caller.principal.workerId ||
      a.assignmentId !== caller.assignmentId ||
      a.sessionId !== caller.sessionId ||
      a.dispatchAttemptId !== caller.dispatchAttemptId
    ) {
      refuse("Processor assignment does not match the authenticated caller.");
    }
    if (
      mode === "complete" ? a.settlementGranted !== true : a.ctxGranted !== true
    ) {
      refuse("Processor authority was revoked.");
    }
    const processor = options.registry.processorForConsumer(
      processorConsumerId(a.processorId),
    );
    if (!processor || processor.id !== a.processorId) {
      throw new TypeError("Registered Processor is unavailable.");
    }
    // Preserve operation -> delivery lock order, including detached scopes.
    const initial = await tx.query<{ settlement_scope_id: string }>(
      `SELECT settlement_scope_id FROM ${tables.event_deliveries} WHERE id=$1`,
      [a.deliveryId],
    );
    const source = initial.rows[0];
    if (!source) refuse("Processor delivery is unavailable.");
    const scopes = await tx.query<
      { state: string; cancellation_requested_at: unknown }
    >(
      `SELECT state,cancellation_requested_at FROM ${operationTables.operations} WHERE namespace=$1 AND operation_id=$2 FOR UPDATE`,
      [a.namespace, source.settlement_scope_id],
    );
    const scope = scopes.rows[0];
    if (!scope || !["accepted", "running"].includes(scope.state)) {
      refuse("Processor scope is no longer live.");
    }
    const cancelled = scope.cancellation_requested_at != null;
    if (cancelled && mode !== "complete") {
      refuse("Processor scope was cancelled.");
    }
    await tx.query(
      `SELECT id FROM ${tables.event_deliveries} WHERE id=$1 FOR UPDATE`,
      [a.deliveryId],
    );
    const store = readStore(tx);
    const delivery = await store.getDelivery(a.deliveryId);
    const event = await store.getEvent(a.sourceEventId);
    if (
      !delivery || !event || event.namespace !== a.namespace ||
      delivery.eventId !== a.sourceEventId ||
      delivery.consumerId !== processorConsumerId(a.processorId) ||
      delivery.settlementScopeId !== source.settlement_scope_id
    ) {
      refuse("Processor delivery or source identity changed.");
    }
    const time = Date.parse(commandTime);
    const live = delivery.status === "leased" &&
      delivery.leaseOwner === a.dispatchAttemptId &&
      delivery.leaseExpiresAt == null;
    if (mode === "claim") {
      const eligible = delivery.attempts < delivery.maxAttempts &&
        ["pending", "retry_wait"].includes(delivery.status) &&
        Date.parse(delivery.availableAt) <= time;
      // Expired attempts need host recovery before another assignment is bound.
      if (!eligible && !live) refuse("Processor delivery is not claimable.");
    } else if (!live) refuse("Processor attempt lease is no longer live.");
    return { assignment: a, processor, delivery, event, cancelled };
  }
  function bound(tx: SqlExecutor) {
    const value = authorized.get(tx);
    if (!value) refuse("Processor handler requires boundary authorization.");
    return value;
  }
  async function readData(tx: SqlExecutor, state: Authorized) {
    const payload = matchDataFromPayload(state.event.payload);
    const data = json(
      payload === undefined
        ? await readEventBody(
          { transaction: tx, tables },
          state.event.namespace,
          eventDataRef(state.event.payload),
        )
        : payload,
    );
    ordinary(state.event);
    ordinary(data);
    if (!matchProcessor(state.processor, state.event, data)) {
      refuse("Processor no longer matches its assigned event.");
    }
    return data;
  }
  async function projectData(tx: SqlExecutor, state: Authorized, time: string) {
    const data = await readData(tx, state);
    await options.authorizeEvent(
      tx,
      structuredClone(state.assignment),
      structuredClone(state.event),
      structuredClone(data),
      time,
    );
    return data;
  }
  async function recheckWorker(
    tx: SqlExecutor,
    caller: OwnerCaller,
    time: string,
    state: Authorized,
    data: OwnerJson,
    mode: "claim" | "input" | "mutation",
  ) {
    // Re-resolve grants after event policy without recursively invoking it.
    // Then reread durable facts and the separately stored event body.
    const after = await current(tx, caller, time, mode);
    if (
      exact(ownerAssignmentFacts(after.assignment)) !==
        exact(ownerAssignmentFacts(state.assignment)) ||
      exact(after.delivery) !== exact(state.delivery) ||
      exact(after.event) !== exact(state.event) ||
      exact(await readData(tx, after)) !== exact(data)
    ) refuse("Processor state changed across authorization.");
  }
  type LocalRead = Readonly<{
    delivery: EventDelivery;
    event: DurableEvent;
    processor: Processor;
    cancelled: boolean;
    availableAt: string;
    due: boolean;
    reserved: boolean;
    unleased: boolean;
    snapshot: string;
  }>;
  type LocalAuthorized = Readonly<{
    data?: OwnerJson;
    assignment: OwnerLocalProcessorAssignment;
    read: LocalRead;
    phase: LocalPhase;
    caller: string;
    command: string;
    time: string;
  }>;
  const localAuthorized = new WeakMap<SqlExecutor, LocalAuthorized>();
  function exact(value: unknown): string {
    return JSON.stringify(
      json(value),
      (_, item) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? Object.fromEntries(
            Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
          )
          : item,
    );
  }
  function privateCurrent(
    caller: OwnerCaller,
    assignment: OwnerLocalProcessorAssignment,
    phase: LocalPhase,
  ) {
    let result: unknown;
    try {
      result = local?.isCurrent(
        structuredClone(caller),
        bindingOf(assignment),
        assignment.attemptOrdinal,
        phase,
      );
    } catch {
      refuse("Local Processor private authority is unavailable.");
    }
    if (result !== true) {
      refuse("Local Processor private authority is unavailable.");
    }
  }
  async function localFence(
    tx: SqlExecutor,
    caller: OwnerCaller,
    binding: OwnerLocalProcessorAssignmentBinding,
    start: boolean,
  ) {
    if (!local || binding.ownerId !== options.ownerId) {
      refuse("Local Processor capability is unavailable.");
    }
    if (start) {
      const p = caller.principal;
      ownerPrincipalIdentity(p);
      if (
        p.kind !== "owner-control" || p.ownerId !== binding.ownerId ||
        p.epoch !== binding.epoch || p.holderId !== binding.holderId ||
        caller.ownerEpoch !== binding.epoch || Object.hasOwn(caller, "workerId")
      ) refuse("Local Processor start requires exact owner control.");
    } else assertOwnerAttemptCaller(caller, binding, options.ownerId);
    const fence = await tx.query(
      `SELECT owner FROM ${
        ownerTableNames(options.schema).epochs
      } WHERE owner=$1 AND epoch=$2 AND holder=$3 FOR SHARE`,
      [options.ownerId, binding.epoch, binding.holderId],
    );
    if (fence.rows.length !== 1) refuse("Local Processor owner fence changed.");
  }
  async function readLocal(
    tx: SqlExecutor,
    binding: OwnerLocalProcessorAssignmentBinding,
    time: string,
  ): Promise<LocalRead> {
    const processor = options.registry.processorForConsumer(binding.consumerId);
    if (!processor || processor.id !== binding.processorId) {
      refuse("Registered local Processor is unavailable.");
    }
    const first = (await tx.query<{ settlement_scope_id: string }>(
      `SELECT settlement_scope_id FROM ${tables.event_deliveries} WHERE id=$1`,
      [binding.deliveryId],
    )).rows[0];
    if (!first) refuse("Local Processor delivery is unavailable.");
    text(first.settlement_scope_id);
    const scope = (await tx.query<{ state: string; cancelled: string | null }>(
      `SELECT state,cancellation_requested_at::text AS cancelled FROM ${operationTables.operations} WHERE namespace=$1 AND operation_id=$2 FOR UPDATE`,
      [binding.namespace, first.settlement_scope_id],
    )).rows[0];
    if (!scope || !["accepted", "running"].includes(scope.state)) {
      refuse("Local Processor scope is no longer live.");
    }
    await tx.query(
      `SELECT id FROM ${tables.event_deliveries} WHERE id=$1 FOR UPDATE`,
      [binding.deliveryId],
    );
    const store = readStore(tx);
    const delivery = await store.getDelivery(binding.deliveryId);
    const event = await store.getEvent(binding.sourceEventId);
    if (
      !delivery || !event || event.ownerId !== options.ownerId ||
      event.namespace !== binding.namespace ||
      event.id !== binding.sourceEventId ||
      delivery.eventId !== event.id ||
      delivery.consumerId !== binding.consumerId ||
      delivery.settlementScopeId !== first.settlement_scope_id
    ) refuse("Local Processor source or delivery identity changed.");
    const row = (await tx.query<{
      status: EventDelivery["status"];
      attempts: number;
      max_attempts: number;
      available_at: string;
      lease_owner: string | null;
      lease_expires_at: string | null;
      action_scope_id: string | null;
      due: boolean;
      matches: boolean;
      reserved: boolean;
      operation_state: string;
      cancellation_requested_at: string | null;
      metadata_object: boolean;
      raw_metadata: unknown;
    }>(
      `SELECT d.status,d.attempts,d.max_attempts,d.available_at::text AS available_at,
        d.lease_owner,d.lease_expires_at::text AS lease_expires_at,d.action_scope_id,
        d.available_at <= $6::timestamptz AS due,
        (d.event_id=$2 AND d.consumer_id=$3 AND d.settlement_scope_id=$4
          AND e.owner_id=$5 AND e.namespace=$7) AS matches,
        o.state AS operation_state,o.cancellation_requested_at::text AS cancellation_requested_at,
        (jsonb_typeof(e.metadata)='object' AND octet_length(e.metadata::text)<=1048576) AS metadata_object,
        CASE WHEN jsonb_typeof(e.metadata)='object' AND octet_length(e.metadata::text)<=1048576 THEN e.metadata END AS raw_metadata,
        EXISTS(SELECT 1 FROM ${
        quoteEventIdentifier(options.schema)
      }."owner_assignments" a
          WHERE a.owner=$5 AND a.epoch=$8 AND a.assignment_key=$9
            AND a.delivery_id=d.id AND a.binding=$10::jsonb AND a.retired=FALSE) AS reserved
       FROM ${tables.event_deliveries} d JOIN ${tables.events} e ON e.id=d.event_id
       JOIN ${operationTables.operations} o ON o.namespace=$7 AND o.operation_id=d.settlement_scope_id
       WHERE d.id=$1 FOR UPDATE OF d`,
      [
        binding.deliveryId,
        binding.sourceEventId,
        binding.consumerId,
        first.settlement_scope_id,
        options.ownerId,
        time,
        binding.namespace,
        binding.epoch,
        ownerAssignmentKey(options.ownerId, binding),
        JSON.stringify(binding),
      ],
    )).rows[0];
    if (
      !row || row.matches !== true || typeof row.available_at !== "string" ||
      typeof row.due !== "boolean" || typeof row.reserved !== "boolean" ||
      !["accepted", "running"].includes(row.operation_state) ||
      row.status !== delivery.status || row.attempts !== delivery.attempts ||
      row.max_attempts !== delivery.maxAttempts ||
      (row.action_scope_id ?? undefined) !== delivery.actionScopeId ||
      (row.lease_owner ?? undefined) !== delivery.leaseOwner ||
      !Number.isSafeInteger(row.attempts) || row.attempts < 0 ||
      !Number.isSafeInteger(row.max_attempts) || row.max_attempts < 1 ||
      (row.cancellation_requested_at !== null &&
        typeof row.cancellation_requested_at !== "string")
    ) refuse("Local Processor persisted state changed.");
    // mapEvent deliberately normalizes malformed metadata to {} for other
    // consumers. Local ordinary-only admission must validate the raw SQL shape
    // first, so array/scalar/protected data cannot disappear in that mapping.
    if (row.metadata_object !== true) {
      throw Object.assign(
        new TypeError("Local Processor metadata must be an ordinary object."),
        {
          code: "ordinary_value_unsupported",
        },
      );
    }
    const metadata = json(row.raw_metadata);
    assertOwnerOrdinaryValue(metadata);
    if (exact(metadata) !== exact(event.metadata)) {
      refuse("Local Processor source metadata changed while reading.");
    }
    // Only local routes gain the strict ordinary-family guard in this slice.
    // Keep the accepted worker path's compatibility behavior unchanged.
    assertOwnerOrdinaryValue(json(event));
    text(row.available_at);
    const { reserved: _reserved, ...snapshot } = row;
    return {
      delivery: { ...delivery, availableAt: row.available_at },
      event,
      processor,
      cancelled: row.cancellation_requested_at !== null,
      availableAt: row.available_at,
      due: row.due,
      reserved: row.reserved,
      unleased: row.lease_owner === null && row.lease_expires_at === null,
      snapshot: exact({
        row: snapshot,
        event,
        scope: first.settlement_scope_id,
      }),
    };
  }
  function liveLocal(
    read: LocalRead,
    a: OwnerLocalProcessorAssignment,
    phase: LocalPhase,
  ) {
    if (
      !read.reserved || read.delivery.attempts !== a.attemptOrdinal ||
      !ownerAttemptIsLive(read.delivery, a) ||
      (phase === "settlement" ? !a.settlementGranted : !a.ctxGranted) ||
      (read.cancelled && phase !== "settlement")
    ) refuse("Local Processor attempt, grant or ordinal is no longer live.");
  }
  async function readLocalData(tx: SqlExecutor, read: LocalRead) {
    const payload = matchDataFromPayload(read.event.payload);
    const data = json(
      payload === undefined
        ? await readEventBody(
          { transaction: tx, tables },
          read.event.namespace,
          eventDataRef(read.event.payload),
        )
        : payload,
    );
    assertOwnerOrdinaryValue(data);
    if (!matchProcessor(read.processor, read.event, data)) {
      refuse("Local Processor no longer matches its source.");
    }
    return data;
  }
  async function localData(
    tx: SqlExecutor,
    a: OwnerLocalProcessorAssignment,
    read: LocalRead,
    time: string,
  ) {
    const data = await readLocalData(tx, read);
    await local!.authorizeEvent(
      tx,
      structuredClone(a),
      structuredClone(read.event),
      structuredClone(data),
      time,
    );
    return data;
  }
  async function currentLocal(
    tx: SqlExecutor,
    caller: OwnerCaller,
    time: string,
    phase: "ctx" | "settlement",
  ) {
    if (!local) refuse("Local Processor capability is unavailable.");
    const found = await local.resolveAssignment(
      tx,
      structuredClone(caller),
      time,
    );
    if (!found) refuse("Local Processor assignment is no longer current.");
    const assignment = localAssignment(found);
    const binding = bindingOf(assignment);
    await localFence(tx, caller, binding, false);
    const read = await readLocal(tx, binding, time);
    liveLocal(read, assignment, phase);
    privateCurrent(caller, assignment, phase);
    return { assignment, read };
  }
  async function recheckLocal(
    tx: SqlExecutor,
    caller: OwnerCaller,
    time: string,
    state: Pick<LocalAuthorized, "assignment" | "read" | "phase" | "data">,
  ) {
    if (state.phase !== "start") {
      const found = await local!.resolveAssignment(
        tx,
        structuredClone(caller),
        time,
      );
      if (!found) refuse("Local Processor assignment is no longer current.");
      const actual = localAssignment(found);
      if (
        (state.phase === "ctx"
            ? actual.ctxGranted
            : actual.settlementGranted) !== true ||
        exact(ownerAssignmentFacts(actual)) !==
          exact(ownerAssignmentFacts(state.assignment))
      ) {
        refuse("Local Processor grants changed across authorization.");
      }
    }
    const read = await readLocal(tx, bindingOf(state.assignment), time);
    if (read.snapshot !== state.read.snapshot) {
      refuse("Local Processor state changed across authorization.");
    }
    if (state.phase !== "start") {
      liveLocal(read, state.assignment, state.phase);
    }
    if (
      state.phase !== "settlement" &&
      (state.data === undefined ||
        exact(await readLocalData(tx, read)) !== exact(state.data))
    ) {
      refuse("Local Processor body changed across authorization.");
    }
    privateCurrent(caller, state.assignment, state.phase);
    return read;
  }
  function consumeLocal(
    context: Pick<OwnerCommandContext, "tx" | "caller" | "commandTime">,
    kind: string,
    intent: OwnerJson,
    command?: OwnerCommandContext["command"],
  ) {
    const state = localAuthorized.get(context.tx);
    localAuthorized.delete(context.tx);
    if (
      !state || state.time !== context.commandTime ||
      state.caller !== exact(context.caller) ||
      state.command !==
        exact({
          kind,
          intent,
          ...(command ? { domain: command.domain, key: command.key } : {}),
        })
    ) {
      refuse(
        "Local Processor handler requires exact command-local authorization.",
      );
    }
    privateCurrent(context.caller, state.assignment, state.phase);
    return state;
  }
  const startLocal: OwnerCommandHandler = async (intent, context) => {
    const state = consumeLocal(
      context,
      "owner.local-processor-start",
      intent,
      context.command,
    );
    const binding = bindingOf(state.assignment);
    await recheckLocal(context.tx, context.caller, context.commandTime, state);
    await local!.reserveLocal(context, localBinding(binding));
    const reserved = await recheckLocal(
      context.tx,
      context.caller,
      context.commandTime,
      state,
    );
    if (!reserved.reserved) {
      refuse("Local Processor start did not reserve its exact attempt.");
    }
    const claimed = await runtime(context, binding).claimDelivery({
      id: binding.deliveryId,
      owner: binding.attemptId,
    });
    if (
      !claimed || claimed.attempts !== state.assignment.attemptOrdinal ||
      !ownerAttemptIsLive(claimed, binding)
    ) {
      refuse("Local Processor claim did not acquire the expected ordinal.");
    }
    await options.scheduleSettlement(context, {
      namespace: binding.namespace,
      operationId: claimed.settlementScopeId,
    });
    // The hooks above joined SQL only. Revocation during a final read or
    // scheduling await must roll the whole claim/reservation back, not emit a
    // receipt that could activate an already-revoked private entry.
    privateCurrent(context.caller, state.assignment, "start");
    return { binding, attempts: claimed.attempts };
  };
  const projectLocal: OwnerProjectionHandler = async (intent, context) => {
    const state = consumeLocal(context, "processor.local-input", intent);
    const data = await localData(
      context.tx,
      state.assignment,
      state.read,
      context.commandTime,
    );
    await recheckLocal(context.tx, context.caller, context.commandTime, {
      ...state,
      data,
    });
    const a = state.assignment, read = state.read;
    const value: OwnerLocalProcessorProjection = {
      reference: bindingOf(a),
      processorId: a.processorId,
      ownerId: options.ownerId,
      namespace: a.namespace,
      databaseSchema: options.schema,
      deliveryId: a.deliveryId,
      event: { ...read.event, data },
      attempts: read.delivery.attempts,
      maxAttempts: read.delivery.maxAttempts,
      operationKey: ownerProcessorOperationKey(a.deliveryId),
      identity: {
        causationId: read.event.id,
        correlationId: read.event.correlationId,
        settlementScopeId: read.delivery.settlementScopeId,
        ...(read.delivery.actionScopeId
          ? { actionScopeId: read.delivery.actionScopeId }
          : {}),
      },
    };
    return json(value);
  };
  const localSettlement: OwnerProjectionHandler = async (intent, context) => {
    const state = consumeLocal(
      context,
      "processor.local-settlement-state",
      intent,
    );
    await recheckLocal(context.tx, context.caller, context.commandTime, state);
    return {
      reference: bindingOf(state.assignment),
      cancellationRequested: state.read.cancelled,
    };
  };
  async function settleAttempt(
    store: ReturnType<typeof createEventStore>,
    id: string,
    owner: string,
    result: RegisteredProcessorCompletion,
  ) {
    return result.status === "succeeded"
      ? await store.succeedDelivery(id, owner)
      : result.status === "cancelled"
      ? await store.cancelDelivery(id, owner)
      : await store.failDelivery({
        id,
        owner,
        error: { name: "ProcessorExecutionFailed", message: result.code },
        retryable: result.retryable,
      });
  }
  const completeLocal: OwnerCommandHandler = async (intent, context) => {
    const state = consumeLocal(
      context,
      "processor.local-complete",
      intent,
      context.command,
    );
    await recheckLocal(context.tx, context.caller, context.commandTime, state);
    const binding = bindingOf(state.assignment);
    const result = completion((intent as { completion: OwnerJson }).completion);
    if (state.read.cancelled && result.status !== "cancelled") {
      refuse("Scope cancellation takes precedence over Processor completion.");
    }
    const settled = await settleAttempt(
      runtime(context, binding),
      binding.deliveryId,
      binding.attemptId,
      result,
    );
    if (!settled) refuse("Local Processor settlement lost its attempt.");
    await local!.retireLocal(context, localBinding(binding));
    const actual = (await context.tx.query<
      {
        status: string;
        attempts: number;
        available_at: string;
        retired: boolean;
      }
    >(
      `SELECT d.status,d.attempts,d.available_at::text AS available_at,
        EXISTS(SELECT 1 FROM ${
        quoteEventIdentifier(options.schema)
      }."owner_assignments" a
          WHERE a.owner=$2 AND a.epoch=$3 AND a.assignment_key=$4 AND a.delivery_id=d.id
            AND a.binding=$5::jsonb AND a.retired=TRUE) AS retired
       FROM ${tables.event_deliveries} d WHERE d.id=$1 AND d.lease_owner IS NULL AND d.lease_expires_at IS NULL`,
      [
        binding.deliveryId,
        options.ownerId,
        binding.epoch,
        ownerAssignmentKey(options.ownerId, binding),
        JSON.stringify(binding),
      ],
    )).rows[0];
    if (
      !actual || actual.status !== settled.status ||
      actual.attempts !== state.assignment.attemptOrdinal ||
      typeof actual.available_at !== "string" || actual.retired !== true ||
      !["succeeded", "dead_letter", "cancelled", "retry_wait"].includes(
        actual.status,
      )
    ) {
      refuse("Local Processor ended-attempt state or retirement changed.");
    }
    await options.scheduleSettlement(context, {
      namespace: binding.namespace,
      operationId: settled.settlementScopeId,
    });
    if (actual.status === "retry_wait") {
      await options.scheduleRetry(context, {
        ...settled,
        availableAt: actual.available_at,
      });
      privateCurrent(context.caller, state.assignment, "settlement");
      return json(
        {
          reference: binding,
          attempts: actual.attempts,
          status: "retry_wait",
          availableAt: actual.available_at,
        } satisfies OwnerLocalProcessorAttemptReceipt,
      );
    }
    if (
      actual.status !== "succeeded" && actual.status !== "dead_letter" &&
      actual.status !== "cancelled"
    ) {
      refuse("Local Processor completion has no ended-attempt receipt.");
    }
    // SQL retirement does not revoke/free the private entry. Its settlement
    // witness remains required through the last awaited scheduling operation.
    privateCurrent(context.caller, state.assignment, "settlement");
    return json(
      {
        reference: binding,
        attempts: actual.attempts,
        status: actual.status,
      } satisfies OwnerLocalProcessorAttemptReceipt,
    );
  };
  async function authorizeLocal(
    tx: SqlExecutor,
    caller: OwnerCaller,
    command: OwnerCommand,
    time: string,
  ) {
    localAuthorized.delete(tx);
    const start = command.kind === "owner.local-processor-start";
    const phase: LocalPhase = start
      ? "start"
      : command.kind === "processor.local-input"
      ? "ctx"
      : "settlement";
    let state: {
      assignment: OwnerLocalProcessorAssignment;
      read: LocalRead;
      data?: OwnerJson;
    };
    if (start) {
      const binding = localBinding(command.intent);
      if (
        command.domain !== "incarnation" ||
        command.key !== ownerLocalProcessorStartKey(binding)
      ) {
        refuse("Local Processor start command identity is invalid.");
      }
      await localFence(tx, caller, binding, true);
      const read = await readLocal(tx, binding, time);
      if (
        read.cancelled || !read.due || read.reserved || !read.unleased ||
        read.delivery.attempts >= read.delivery.maxAttempts ||
        !((read.delivery.status === "pending" &&
          read.delivery.attempts === 0) ||
          (read.delivery.status === "retry_wait" && read.delivery.attempts > 0))
      ) {
        refuse(
          "Local Processor start requires a fresh or authorized due retry.",
        );
      }
      const grant = await local!.authorizeStart(
        tx,
        structuredClone(caller),
        localBinding(binding),
        {
          status: read.delivery.status,
          attempts: read.delivery.attempts,
          maxAttempts: read.delivery.maxAttempts,
          availableAt: read.availableAt,
        } as OwnerLocalProcessorStartFacts,
        time,
      );
      if (!grant) {
        refuse("Current private local Processor start authority is required.");
      }
      const { attemptOrdinal } = localOwn(grant, ["attemptOrdinal"]);
      if (
        !Number.isSafeInteger(attemptOrdinal) ||
        attemptOrdinal !== read.delivery.attempts + 1
      ) {
        refuse("Local Processor start ordinal is not the next actual attempt.");
      }
      state = {
        assignment: {
          ...binding,
          attemptOrdinal: Number(attemptOrdinal),
          ctxGranted: true,
          settlementGranted: true,
        },
        read,
      };
      state.data = await localData(tx, state.assignment, read, time);
    } else {
      state = await currentLocal(
        tx,
        caller,
        time,
        phase as "ctx" | "settlement",
      );
      const binding = bindingOf(state.assignment);
      if (command.kind === "processor.local-complete") {
        const data = object(command.intent, ["reference", "completion"]);
        if (
          exact(localBinding(data.reference)) !== exact(binding) ||
          command.domain !== "incarnation" ||
          command.key !== ownerLocalProcessorCompletionKey(binding)
        ) refuse("Local Processor completion identity is invalid.");
        const result = completion(data.completion);
        if (state.read.cancelled && result.status !== "cancelled") {
          refuse(
            "Scope cancellation takes precedence over Processor completion.",
          );
        }
      } else if (exact(localBinding(command.intent)) !== exact(binding)) {
        refuse("Local Processor projection identity is invalid.");
      }
      if (phase === "ctx") {
        state.data = await localData(tx, state.assignment, state.read, time);
      }
    }
    await recheckLocal(tx, caller, time, { ...state, phase });
    localAuthorized.set(tx, {
      ...state,
      phase,
      caller: exact(caller),
      time,
      command: exact({
        kind: command.kind,
        intent: command.intent,
        ...(start || command.kind === "processor.local-complete"
          ? { domain: command.domain, key: command.key }
          : {}),
      }),
    });
  }

  const claim: OwnerCommandHandler = async (_intent, context) => {
    const state = bound(context.tx);
    const data = await projectData(context.tx, state, context.commandTime);
    await recheckWorker(
      context.tx,
      context.caller,
      context.commandTime,
      state,
      data,
      "claim",
    );
    const delivery = await runtime(context).claimDelivery({
      id: state.delivery.id,
      owner: state.assignment.dispatchAttemptId,
    });
    if (!delivery) refuse("Processor claim did not acquire a fresh attempt.");
    await options.scheduleSettlement(context, {
      namespace: state.assignment.namespace,
      operationId: delivery.settlementScopeId,
    });
    return reference(state.assignment);
  };
  const complete: OwnerCommandHandler = async (intent, context) => {
    const state = bound(context.tx);
    const result = completion((intent as { completion: OwnerJson }).completion);
    const store = runtime(context);
    const id = state.delivery.id;
    const owner = state.assignment.dispatchAttemptId;
    const settled = await settleAttempt(store, id, owner, result);
    if (!settled) refuse("Processor settlement lost its attempt.");
    await options.scheduleSettlement(context, {
      namespace: state.assignment.namespace,
      operationId: settled.settlementScopeId,
    });
    if (settled.status === "retry_wait") {
      await options.scheduleRetry(context, settled);
    }
    return { ...reference(state.assignment), status: settled.status };
  };
  const project: OwnerProjectionHandler = async (_intent, context) => {
    const state = bound(context.tx);
    const data = await projectData(context.tx, state, context.commandTime);
    await recheckWorker(
      context.tx,
      context.caller,
      context.commandTime,
      state,
      data,
      "input",
    );
    return json({
      processorId: state.processor.id,
      ownerId: options.ownerId,
      workerId: state.assignment.workerId,
      namespace: state.assignment.namespace,
      databaseSchema: options.schema,
      event: { ...state.event, data },
      attempts: state.delivery.attempts,
      maxAttempts: state.delivery.maxAttempts,
      operationKey: ownerProcessorOperationKey(state.delivery.id),
      identity: {
        causationId: state.event.id,
        correlationId: state.event.correlationId,
        settlementScopeId: state.delivery.settlementScopeId,
        ...(state.delivery.actionScopeId
          ? { actionScopeId: state.delivery.actionScopeId }
          : {}),
      },
    });
  };
  return {
    handlers: {
      "owner.local-processor-start": startLocal,
      "processor.local-complete": completeLocal,
      "processor.claim": claim,
      "processor.complete": complete,
    },
    projections: {
      "processor.input": project,
      "processor.local-input": projectLocal,
      "processor.local-settlement-state": localSettlement,
    },
    async authorize(
      tx: SqlExecutor,
      caller: OwnerCaller,
      command: OwnerCommand,
      time: string,
    ) {
      localAuthorized.delete(tx);
      if (
        [
          "owner.local-processor-start",
          "processor.local-input",
          "processor.local-settlement-state",
          "processor.local-complete",
        ].includes(command.kind)
      ) {
        return await authorizeLocal(tx, caller, command, time);
      }
      const mode = command.kind === "processor.claim"
        ? "claim"
        : command.kind === "processor.complete"
        ? "complete"
        : command.kind === "processor.input"
        ? "input"
        : undefined;
      if (!mode) throw new TypeError("Unknown Processor command.");
      const state = await current(tx, caller, time, mode);
      const a = state.assignment;
      if (mode === "claim") {
        const data = object(command.intent, ["assignmentId", "sessionId"]);
        if (
          command.domain !== "incarnation" ||
          command.key !==
            ownerProcessorClaimKey(
              options.ownerId,
              a.assignmentId,
              a.sessionId,
            ) ||
          data.assignmentId !== a.assignmentId || data.sessionId !== a.sessionId
        ) refuse("Processor claim identity is not assigned.");
      } else if (mode === "complete") {
        const data = object(command.intent, ["reference", "completion"]);
        checkReference(data.reference, a);
        if (
          command.domain !== "incarnation" ||
          command.key !==
            ownerProcessorCompletionKey(options.ownerId, reference(a))
        ) {
          refuse("Processor completion identity is not assigned.");
        }
        if (
          state.cancelled && completion(data.completion).status !== "cancelled"
        ) {
          refuse(
            "Scope cancellation takes precedence over Processor completion.",
          );
        }
        completion(data.completion);
      } else checkReference(command.intent, a);
      authorized.set(tx, state);
    },
    /** Private local composition only; does not widen the worker return type. */
    async authorizeLocalLive(
      tx: SqlExecutor,
      caller: OwnerCaller,
      time: string,
    ) {
      localAuthorized.delete(tx);
      const state = await currentLocal(tx, caller, time, "ctx");
      const data = await localData(tx, state.assignment, state.read, time);
      await recheckLocal(tx, caller, time, { ...state, phase: "ctx", data });
      return {
        assignment: state.assignment,
        delivery: state.read.delivery,
        event: state.read.event,
      };
    },
    /** Host composes Collection/nested-Action policy after this live attempt fence. */
    async authorizeLive(tx: SqlExecutor, caller: OwnerCaller, time: string) {
      const state = await current(tx, caller, time, "mutation");
      // Current event policy also gates dependent writes and child admission,
      // including receipt replay. Settlement remains separately authorized.
      const data = await projectData(tx, state, time);
      await recheckWorker(tx, caller, time, state, data, "mutation");
      return {
        assignment: state.assignment,
        delivery: state.delivery,
        event: state.event,
      };
    },
  };
}
