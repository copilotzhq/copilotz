/** Private ordinary-JSON Action execution on the existing delivery/lifecycle tables.
 * The trusted host has already selected an Action and a body-backed input event.
 * This is not a generic Processor-event-to-Action conversion or a public factory. */
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
import { recoverDeliveryActions } from "../actions/recovery.ts";
import { validateAgainstJsonSchema } from "../collections/validate.ts";
import { eventDataRef, readEventBody } from "../events/body-store.ts";
import {
  createEventCoordinator,
  type EventPublisher,
} from "../events/coordinator.ts";
import { createCoreTableNames } from "../events/schema.ts";
import type { SqlExecutor, SqlSession } from "../events/session.ts";
import { createEventStore, type EventStore } from "../events/store.ts";
import type { EventDelivery } from "../events/types.ts";
import type { DeliveryExecutor } from "../execution/types.ts";
import type {
  RegisteredExecutionCompletion,
  RegisteredExecutionProjection,
  RegisteredExecutionReference,
} from "../execution/registered-worker.ts";
import {
  ownerClaimKey,
  ownerCompletionKey,
  ownerRenewalKey,
} from "../execution/owner-port.ts";
import { assertJsonValue } from "../json.ts";
import { readExecutionClaim } from "../execution/recovery.ts";
import type { RegisteredExecutionRecovery } from "../execution/recovery.ts";
import { readOwnerEffectInventory } from "./effects.ts";
import { ownerTableNames } from "./schema.ts";
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

/** Current, host-owned state. The resolver must verify the live parent transport
 * assignment/session, not reproduce bindings supplied in a command payload.
 * Each dispatchAttemptId is host-issued and never reused by a replacement. */
export type OwnerExecutionAssignment = Readonly<{
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

type Authorized = Readonly<{
  assignment: OwnerExecutionAssignment;
  action: AnyActionDefinition;
  delivery: EventDelivery;
  cancelled: boolean;
  correlationId: string;
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
function reference(
  assignment: OwnerExecutionAssignment,
): RegisteredExecutionReference {
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
  const data = object(input, [
    "executionId",
    "deliveryId",
    "dispatchAttemptId",
  ]);
  const expected = reference(assignment);
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
    catalog: OperationCatalog;
    executor: DeliveryExecutor;
    publish?: EventPublisher;
    leaseMs?: number;
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
    ):
      | OwnerExecutionAssignment
      | undefined
      | Promise<OwnerExecutionAssignment | undefined>;
    /** Transitional, SQL-only assertion that this registered Action and its
     * adapters use the effect protocol. No caller data may establish this fact.
     * Defaults to refusal for a lost prior attempt, even with no effect receipts.
     * Rechecked on recovery projection and every ordinary mutation. */
    allowRecovery?(
      tx: SqlExecutor,
      assignment: OwnerExecutionAssignment,
      actionId: string,
      commandTime: string,
    ): boolean | Promise<boolean>;
    /** Mandatory current input policy. Called before capture and each projection.
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
  handlers: Readonly<Record<string, OwnerCommandHandler>>;
  projections: Readonly<Record<string, OwnerProjectionHandler>>;
  authorize(
    tx: SqlExecutor,
    caller: OwnerCaller,
    command: OwnerCommand,
    commandTime: string,
  ): Promise<void>;
  /** Narrow current-attempt settlement capability, including after ctx
   * revocation. The caller must separately bind the effect reference. */
  authorizeSettlement(
    tx: SqlExecutor,
    caller: OwnerCaller,
    commandTime: string,
  ): Promise<OwnerExecutionAssignment>;
  /** Composition seam for separately key-bound owner Collection commands. */
  authorizeLive(
    tx: SqlExecutor,
    caller: OwnerCaller,
    commandTime: string,
  ): Promise<OwnerExecutionAssignment>;
}> {
  text(options.ownerId);
  if (options.catalog.databaseSchema !== options.schema) {
    throw new TypeError("Execution catalog schema does not match.");
  }
  const leaseMs = options.leaseMs ?? 30_000;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) {
    throw new TypeError("Invalid execution lease.");
  }
  const tables = createCoreTableNames(options.schema);
  const operationTables = createOperationCatalogTables(options.schema);
  const authorized = new WeakMap<SqlExecutor, Authorized>();

  async function current(
    tx: SqlExecutor,
    caller: OwnerCaller,
    commandTime: string,
    mode: "claim" | "input" | "complete" | "mutation" | "renew",
  ): Promise<Authorized> {
    const found = await options.resolveAssignment(tx, caller, commandTime);
    if (!found) refuse("Execution assignment is no longer current.");
    const assignment = structuredClone(found);
    for (
      const value of [
        assignment.ownerId,
        assignment.workerId,
        assignment.assignmentId,
        assignment.sessionId,
        assignment.namespace,
        assignment.actionId,
        assignment.deliveryId,
        assignment.dispatchAttemptId,
        assignment.invocation.actionRunId,
        assignment.invocation.rootKey,
        assignment.invocation.operationKey,
      ]
    ) text(value);
    if (
      assignment.ownerId !== options.ownerId ||
      assignment.workerId !== caller.workerId ||
      assignment.assignmentId !== caller.assignmentId ||
      assignment.sessionId !== caller.sessionId ||
      assignment.dispatchAttemptId !== caller.dispatchAttemptId
    ) {
      refuse("Execution assignment does not match the authenticated caller.");
    }
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
      { settlement_scope_id: string; namespace: string; correlation_id: string }
    >(
      `SELECT d.settlement_scope_id,e.namespace,e.correlation_id FROM ${tables.event_deliveries} d JOIN ${tables.events} e ON e.id=d.event_id WHERE d.id=$1`,
      [assignment.deliveryId],
    );
    const source = initial.rows[0];
    if (!source || source.namespace !== assignment.namespace) {
      refuse("Execution delivery does not belong to this namespace.");
    }
    const scopes = await tx.query<
      { state: string; cancellation_requested_at: unknown }
    >(
      `SELECT state,cancellation_requested_at FROM ${operationTables.operations} WHERE namespace=$1 AND operation_id=$2 FOR UPDATE`,
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
      `SELECT id FROM ${tables.event_deliveries} WHERE id=$1 FOR UPDATE`,
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
    const live = delivery.status === "leased" &&
      delivery.leaseOwner === assignment.dispatchAttemptId &&
      Date.parse(delivery.leaseExpiresAt ?? "") > time;
    if (mode === "claim") {
      const eligible = delivery.attempts < delivery.maxAttempts &&
        ((["pending", "retry_wait"].includes(delivery.status) &&
          Date.parse(delivery.availableAt) <= time) ||
          (delivery.status === "leased" &&
            Date.parse(delivery.leaseExpiresAt ?? "") <= time &&
            delivery.leaseOwner !== assignment.dispatchAttemptId));
      if (!eligible && !live) refuse("Execution delivery is not claimable.");
    } else if (!live) refuse("Execution attempt lease is no longer live.");
    const terminal = await store.getEventByDeduplicationId(
      assignment.namespace,
      `${assignment.invocation.actionRunId}:action:terminal`,
    );
    if (terminal) refuse("Execution already has a terminal lifecycle.");
    return {
      assignment,
      action,
      delivery,
      cancelled,
      correlationId: source.correlation_id,
    };
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
    const rows = await tx.query<
      { worker_id: string; kind: string; intent: unknown; result: unknown }
    >(
      `SELECT worker_id,kind,intent,result FROM ${
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
      row.worker_id !== a.workerId
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
      await options.allowRecovery?.(
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
    const scheduled = new Set<string>();
    const schedule = async (operationId: string) => {
      if (!options.scheduleSettlement || scheduled.has(operationId)) return;
      const namespace = requireAuthorized(context.tx).assignment.namespace;
      await options.scheduleSettlement(context, { namespace, operationId });
      scheduled.add(operationId);
    };
    const store: EventStore = createEventStore({
      session: options.session,
      schema: options.schema,
      ownerCommit: { ...context.ownerCommit, afterCommit: context.afterCommit },
      lockSettlementScope: (tx, scope) => options.catalog.lockScope(tx, scope),
      admitOperationEventSql: (input, param) =>
        options.catalog.admitEventSql(input, param),
      indexOperationEvent: (tx, input) => options.catalog.indexEvent(tx, input),
      indexOperationEventSql: (input, param) =>
        options.catalog.indexEventSql(input, param),
      settleActionOwners: async (tx, delivery) => {
        const publish = await recoverDeliveryActions(
          {
            store,
            coordinator,
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
    const coordinator = createEventCoordinator({
      store,
      registry: options.registry,
      executor: options.executor,
      publish: options.publish,
      scheduleOnly: true,
    });
    const lifecycle = (state: Authorized, cancellation = false) => {
      const append = createActionLifecycleAppender({
        store,
        coordinator,
        actions: options.registry.actions,
        transaction: context.tx,
        commandTime: context.commandTime,
        writer: cancellation
          ? {
            kind: "cancellation",
            namespace: state.assignment.namespace,
            operationId: state.delivery.settlementScopeId,
          }
          : {
            kind: "delivery",
            deliveryId: state.delivery.id,
            leaseOwner: state.assignment.dispatchAttemptId,
          },
      });
      return createActionLifecycleEmitter({
        namespace: state.assignment.namespace,
        metadata: { sourceDeliveryId: state.delivery.id },
        append: async (input) => {
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
      `SELECT action_id,owner_delivery_id,state FROM ${tables.open_actions} WHERE namespace=$1 AND action_run_id=$2 FOR UPDATE`,
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
  const claim: OwnerCommandHandler = async (_intent, context) => {
    const state = requireAuthorized(context.tx);
    const { store, lifecycle, schedule } = runtime(context);
    const captured = await invoked(context.tx, state);
    const delivery = await store.claimDelivery({
      id: state.delivery.id,
      owner: state.assignment.dispatchAttemptId,
      leaseMs,
    });
    // A receiptless live attempt is not a new execution entitlement.
    if (!delivery) refuse("Execution claim did not acquire a fresh attempt.");
    let input: OwnerJson;
    if (captured) input = json(captured.input);
    else {
      const event = await store.getEvent(delivery.eventId);
      if (!event || event.namespace !== state.assignment.namespace) {
        refuse("Execution source event is unavailable.");
      }
      input = json(
        await readEventBody(
          { transaction: context.tx, tables },
          event.namespace,
          eventDataRef(event.payload),
        ),
      );
    }
    await options.authorizeInput(
      context.tx,
      structuredClone(state.assignment),
      json(input),
      context.commandTime,
    );
    if (state.action.inputSchema) {
      validateAgainstJsonSchema(
        state.action.inputSchema,
        input,
        "Action input",
      );
    }
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
    const recovery: RegisteredExecutionRecovery | undefined =
      delivery.attempts > 1
        ? {
          status: await options.allowRecovery?.(
              context.tx,
              structuredClone(state.assignment),
              state.action.id,
              context.commandTime,
            ) === true
            ? "eligible"
            : "blocked",
          effects: await inventory(context.tx, state),
        }
        : undefined;
    return json({
      ...reference(state.assignment),
      ...(recovery ? { recovery } : {}),
    });
  };
  function leaseTiming(expiresAt: string, commandTime: string) {
    const remainingMs = Date.parse(expiresAt) - Date.parse(commandTime);
    if (!Number.isSafeInteger(remainingMs) || remainingMs <= 0) {
      refuse("Execution lease has no remaining budget.");
    }
    return {
      remainingMs,
      renewAfterMs: Math.max(1, Math.min(10_000, Math.floor(remainingMs / 3))),
    };
  }
  const renew: OwnerCommandHandler = async (_intent, context) => {
    const state = requireAuthorized(context.tx);
    if (!await invoked(context.tx, state)) {
      refuse("Execution has no captured invocation.");
    }
    const { store } = runtime(context);
    if (
      !await store.heartbeatDelivery({
        id: state.delivery.id,
        owner: state.assignment.dispatchAttemptId,
        leaseMs,
      })
    ) {
      refuse("Execution renewal lost its attempt.");
    }
    return json({
      ...reference(state.assignment),
      lease: leaseTiming(
        new Date(Date.parse(context.commandTime) + leaseMs).toISOString(),
        context.commandTime,
      ),
    });
  };
  const complete: OwnerCommandHandler = async (intent, context) => {
    const state = requireAuthorized(context.tx);
    const data = completion((intent as { completion: OwnerJson }).completion);
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
        state.assignment.dispatchAttemptId,
      )
      : data.status === "cancelled"
      ? await store.cancelDelivery(
        state.delivery.id,
        state.assignment.dispatchAttemptId,
      )
      : await store.failDelivery({
        id: state.delivery.id,
        owner: state.assignment.dispatchAttemptId,
        error: { name: "ActionExecutionFailed", message: data.code },
        retryable: false,
      });
    if (!settled) refuse("Execution settlement lost its attempt.");
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
    return json({
      ...(barrier ? { recovery: barrier } : {}),
      actionId: captured.actionId,
      lease: leaseTiming(state.delivery.leaseExpiresAt!, context.commandTime),
      input,
      namespace: state.assignment.namespace,
      databaseSchema: options.schema,
      ownerId: options.ownerId,
      workerId: state.assignment.workerId,
      invocation: {
        ...state.assignment.invocation,
        metadata: captured.metadata,
        ...(captured.parentActionRunId
          ? { parentActionRunId: captured.parentActionRunId }
          : {}),
      },
    });
  };
  return {
    handlers: {
      "execution.claim": claim,
      "execution.complete": complete,
      "execution.renew": renew,
    },
    projections: { "execution.input": project },
    async authorize(tx, caller, command, commandTime) {
      const mode = command.kind === "execution.claim"
        ? "claim"
        : command.kind === "execution.complete"
        ? "complete"
        : command.kind === "execution.input"
        ? "input"
        : command.kind === "execution.renew"
        ? "renew"
        : undefined;
      if (!mode) throw new TypeError("Unknown execution command.");
      const state = await current(tx, caller, commandTime, mode);
      const a = state.assignment;
      if (mode === "claim") {
        const data = object(command.intent, ["assignmentId", "sessionId"]);
        if (
          command.domain !== "incarnation" ||
          command.key !==
            ownerClaimKey(options.ownerId, a.assignmentId, a.sessionId) ||
          data.assignmentId !== a.assignmentId || data.sessionId !== a.sessionId
        ) refuse("Claim identity is not assigned.");
      } else if (mode === "complete") {
        const data = object(command.intent, [
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
          refuse("Scope cancellation takes precedence over worker completion.");
        }
      } else if (mode === "renew") {
        const data = object(command.intent, ["reference", "sequence"]);
        if (
          !Number.isSafeInteger(data.sequence) || Number(data.sequence) < 1 ||
          command.domain !== "occurrence" || command.key !== ownerRenewalKey(
              options.ownerId,
              a.assignmentId,
              a.sessionId,
              Number(data.sequence),
            )
        ) refuse("Renewal identity is not assigned.");
        checkReference(data.reference, a);
      } else checkReference(command.intent, a);
      authorized.set(tx, state);
    },
    async authorizeSettlement(tx, caller, commandTime) {
      const state = await current(tx, caller, commandTime, "complete");
      if (!await invoked(tx, state)) {
        refuse("Execution has no captured invocation.");
      }
      return state.assignment;
    },
    async authorizeLive(tx, caller, commandTime) {
      const state = await current(tx, caller, commandTime, "mutation");
      await recoveryBarrier(tx, state, commandTime);
      return state.assignment;
    },
  };
}
