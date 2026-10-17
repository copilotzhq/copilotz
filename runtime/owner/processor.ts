/** Private durable Processor commands. Delivery bookkeeping is not an Action
 * invocation: no synthetic Action frame, open_action or terminal is created. */
import { isContentRef } from "../content/schema.ts";
import { eventDataRef, readEventBody } from "../events/body-store.ts";
import { createCoreTableNames } from "../events/schema.ts";
import type { SqlExecutor, SqlSession } from "../events/session.ts";
import { createEventStore } from "../events/store.ts";
import type { DurableEvent, EventDelivery } from "../events/types.ts";
import {
  ownerProcessorClaimKey,
  ownerProcessorCompletionKey,
  ownerProcessorOperationKey,
  ownerProcessorRenewalKey,
  type RegisteredProcessorCompletion,
  type RegisteredProcessorReference,
} from "../execution/registered-processor.ts";
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
    leaseMs?: number;
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
  text(options.ownerId);
  if (options.catalog.databaseSchema !== options.schema) {
    throw new TypeError("Processor catalog schema does not match.");
  }
  const leaseMs = options.leaseMs ?? 30_000;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 2) {
    throw new TypeError("Invalid Processor lease.");
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
  const runtime = (context: OwnerCommandContext) =>
    createEventStore({
      session: options.session,
      schema: options.schema,
      ownerCommit: { ...context.ownerCommit, afterCommit: context.afterCommit },
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
    mode: "claim" | "input" | "renew" | "complete" | "mutation",
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
      a.workerId !== caller.workerId ||
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
      Date.parse(delivery.leaseExpiresAt ?? "") > time;
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
  async function projectData(tx: SqlExecutor, state: Authorized, time: string) {
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
    await options.authorizeEvent(
      tx,
      structuredClone(state.assignment),
      structuredClone(state.event),
      structuredClone(data),
      time,
    );
    return data;
  }
  function lease(expiresAt: string, time: string) {
    const remainingMs = Date.parse(expiresAt) - Date.parse(time);
    if (!Number.isSafeInteger(remainingMs) || remainingMs < 2) {
      refuse("Processor lease has no usable remaining budget.");
    }
    return {
      remainingMs,
      renewAfterMs: Math.max(1, Math.min(10_000, Math.floor(remainingMs / 3))),
    };
  }
  const claim: OwnerCommandHandler = async (_intent, context) => {
    const state = bound(context.tx);
    await projectData(context.tx, state, context.commandTime);
    const delivery = await runtime(context).claimDelivery({
      id: state.delivery.id,
      owner: state.assignment.dispatchAttemptId,
      leaseMs,
    });
    if (!delivery) refuse("Processor claim did not acquire a fresh attempt.");
    await options.scheduleSettlement(context, {
      namespace: state.assignment.namespace,
      operationId: delivery.settlementScopeId,
    });
    return reference(state.assignment);
  };
  const renew: OwnerCommandHandler = async (_intent, context) => {
    const state = bound(context.tx);
    if (
      !await runtime(context).heartbeatDelivery({
        id: state.delivery.id,
        owner: state.assignment.dispatchAttemptId,
        leaseMs,
      })
    ) refuse("Processor renewal lost its attempt.");
    return {
      ...reference(state.assignment),
      lease: lease(
        new Date(Date.parse(context.commandTime) + leaseMs).toISOString(),
        context.commandTime,
      ),
    };
  };
  const complete: OwnerCommandHandler = async (intent, context) => {
    const state = bound(context.tx);
    const result = completion((intent as { completion: OwnerJson }).completion);
    const store = runtime(context);
    const id = state.delivery.id;
    const owner = state.assignment.dispatchAttemptId;
    const settled = result.status === "succeeded"
      ? await store.succeedDelivery(id, owner)
      : result.status === "cancelled"
      ? await store.cancelDelivery(id, owner)
      : await store.failDelivery({
        id,
        owner,
        error: { name: "ProcessorExecutionFailed", message: result.code },
        retryable: result.retryable,
      });
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
    return json({
      processorId: state.processor.id,
      ownerId: options.ownerId,
      workerId: state.assignment.workerId,
      namespace: state.assignment.namespace,
      databaseSchema: options.schema,
      event: { ...state.event, data },
      attempts: state.delivery.attempts,
      maxAttempts: state.delivery.maxAttempts,
      lease: lease(state.delivery.leaseExpiresAt!, context.commandTime),
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
      "processor.claim": claim,
      "processor.renew": renew,
      "processor.complete": complete,
    },
    projections: { "processor.input": project },
    async authorize(
      tx: SqlExecutor,
      caller: OwnerCaller,
      command: OwnerCommand,
      time: string,
    ) {
      const mode = command.kind === "processor.claim"
        ? "claim"
        : command.kind === "processor.renew"
        ? "renew"
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
      } else if (mode === "renew") {
        const data = object(command.intent, ["reference", "sequence"]);
        checkReference(data.reference, a);
        if (
          !Number.isSafeInteger(data.sequence) || Number(data.sequence) < 1 ||
          command.domain !== "occurrence" ||
          command.key !==
            ownerProcessorRenewalKey(
              options.ownerId,
              a.assignmentId,
              a.sessionId,
              Number(data.sequence),
            )
        ) {
          refuse("Processor renewal identity is not assigned.");
        }
      } else checkReference(command.intent, a);
      authorized.set(tx, state);
    },
    /** Host composes Collection/nested-Action policy after this fresh lease fence. */
    async authorizeLive(tx: SqlExecutor, caller: OwnerCaller, time: string) {
      const state = await current(tx, caller, time, "mutation");
      // Current event policy also gates dependent writes and child admission,
      // including receipt replay. Settlement remains separately authorized.
      await projectData(tx, state, time);
      return {
        assignment: state.assignment,
        delivery: state.delivery,
        event: state.event,
      };
    },
  };
}
