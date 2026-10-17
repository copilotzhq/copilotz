/** Private parent-bound ordinary JSON Action admission and result projection.
 * The current parent is resolved inside the owner fence before receipt replay.
 * Children join their parent's existing settlement obligation, never ingress. */
import { parseActionLifecycleEvent } from "../actions/event.ts";
import { actionDefinitionHasSecrets } from "../actions/secret.ts";
import type { AnyActionDefinition } from "../actions/types.ts";
import { validateAgainstJsonSchema } from "../collections/validate.ts";
import { digestContent } from "../content/digest.ts";
import { canonicalizeContentRefs } from "../content/input.ts";
import { isContentRef } from "../content/schema.ts";
import { eventDataRef, readEventBody } from "../events/body-store.ts";
import { createCoreTableNames } from "../events/schema.ts";
import type { SqlExecutor, SqlSession } from "../events/session.ts";
import { createEventStore } from "../events/store.ts";
import type { DurableEvent, EventDelivery } from "../events/types.ts";
import { deriveWorkflowId } from "../events/workflow-id.ts";
import {
  OWNER_CHILD_ACTION_ADMISSION,
  OWNER_CHILD_ACTION_RESULT,
  ownerChildActionKey,
  type OwnerChildActionParentReference,
  type OwnerChildActionReference,
} from "../execution/child-action-port.ts";
import { assertJsonValue } from "../json.ts";
import type { PluginRegistry } from "../plugins/registry.ts";
import {
  createOperationCatalogTables,
  type OperationCatalog,
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
import type { OwnerWorkerExecutionAssignment } from "./execution.ts";
import type { OwnerProcessorAssignment } from "./processor.ts";
import type { OwnerPreparedInputContext } from "./preparation.ts";
import {
  OWNER_PREPARATION_METADATA,
  type OwnerPreparationCapture,
  parseOwnerPreparationCapture,
  preparationCaptureFromMetadata,
} from "./preparation-capture.ts";

export {
  OWNER_CHILD_ACTION_ADMISSION,
  OWNER_CHILD_ACTION_RESULT,
  ownerChildActionKey,
};
export type OwnerChildActionBinding =
  | Readonly<{ kind: "action"; assignment: OwnerWorkerExecutionAssignment }>
  | Readonly<{ kind: "processor"; assignment: OwnerProcessorAssignment }>;
/** Derived immutable original facts for current host policy. These do not become
 * Action call metadata; absent call metadata keeps the existing {} semantics. */
export type OwnerChildActionParent = Readonly<{
  namespace: string;
  operationKey: string;
  rootKey: string;
  actionRunId?: string;
  originalMetadata: Readonly<Record<string, OwnerJson>>;
  source: DurableEvent;
  delivery: EventDelivery;
  depth: number;
}>;
type ChildInput = Readonly<{
  parent: OwnerChildActionParentReference;
  actionAlias: string;
  actionId: string;
  operationKey: string;
  input: OwnerJson;
}>;
function refuse(
  message = "Child Action parent authority is unavailable.",
): never {
  throw Object.assign(new Error(message), {
    code: "ActionOwnershipLost",
    name: "ActionOwnershipLost",
  });
}
function unavailable(): never {
  throw Object.assign(new Error("Action result is unavailable."), {
    code: "action_result_unavailable",
  });
}
function text(value: unknown): asserts value is string {
  if (
    typeof value !== "string" || !value.trim() || value !== value.trim() ||
    value.length > 1024
  ) {
    throw new TypeError("Invalid child Action identity.");
  }
}
function json(value: unknown): OwnerJson {
  assertJsonValue(value, {
    maxDepth: 64,
    maxNodes: 100_000,
    rejectNegativeZero: true,
  });
  if (
    new TextEncoder().encode(JSON.stringify(value)).byteLength > 1024 * 1024
  ) {
    throw new TypeError("Child Action data exceeds its limit.");
  }
  return structuredClone(value) as OwnerJson;
}
function object(
  value: unknown,
  keys?: readonly string[],
): Record<string, OwnerJson> {
  const data = json(value);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new TypeError("Child Action requires an object.");
  }
  if (
    keys &&
    (Object.keys(data).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(data, key)))
  ) {
    throw new TypeError(
      "Unsupported child Action fields; metadata, identity and preparation require owner-derived capabilities.",
    );
  }
  return data as Record<string, OwnerJson>;
}
function ordered(value: OwnerJson): OwnerJson {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((
        key,
      ) => [key, ordered((value as Record<string, OwnerJson>)[key])]),
    );
  }
  return value;
}
function same(a: unknown, b: unknown) {
  return JSON.stringify(ordered(json(a))) === JSON.stringify(ordered(json(b)));
}
function ordinary(value: OwnerJson): void {
  if (!value || typeof value !== "object") return;
  const schema = (value as Record<string, OwnerJson>).schema;
  if (
    isContentRef(value) ||
    [
      "copilotz.event.protected-value.v1",
      "copilotz.action.lifecycle.protected.v1",
      "copilotz.action.protected-value.v1",
    ].includes(String(schema))
  ) {
    throw new TypeError("Child Actions support ordinary JSON only.");
  }
  for (const child of Object.values(value)) ordinary(child);
}
function parentReference(value: unknown): OwnerChildActionParentReference {
  const data = object(value, [
    "deliveryId",
    "dispatchAttemptId",
    "operationKey",
  ]);
  for (const value of Object.values(data)) text(value);
  return data as OwnerChildActionParentReference;
}
function childReference(value: unknown): OwnerChildActionReference {
  const data = object(value, [
    "namespace",
    "actionId",
    "executionId",
    "eventId",
    "deliveryId",
  ]);
  for (const value of Object.values(data)) text(value);
  return data as OwnerChildActionReference;
}

export function createOwnerChildActions(
  options: Readonly<{
    ownerId: string;
    schema: string;
    session: SqlSession;
    registry: PluginRegistry;
    catalog: OperationCatalog;
    /** Must call the appropriate execution/Processor authorizeLive first. That
     * includes current host grant, captured execution and recovery barriers. */
    resolveParent(
      tx: SqlExecutor,
      caller: OwnerCaller,
      time: string,
    ):
      | OwnerChildActionBinding
      | undefined
      | Promise<OwnerChildActionBinding | undefined>;
    /** Current operation-specific restrictions; ctx calls are not public ingress.
     * SQL-only and rechecked before every duplicate and output projection. */
    authorizeChild(
      tx: SqlExecutor,
      caller: OwnerCaller,
      parent: OwnerChildActionParent,
      actionId: string,
      time: string,
    ): void | Promise<void>;
    /** Required for prepared lifecycle input/result access. Absence fails closed
     * whenever the requested event contains preparation metadata. */
    authorizePreparedInput?(
      tx: SqlExecutor,
      context: OwnerPreparedInputContext,
    ): void | Promise<void>;
    /** Enqueue references only after COMMIT; never await child execution here. */
    schedule(reference: OwnerChildActionReference): void;
    maxPendingDeliveries?: number;
    maxDepth?: number;
  }>,
) {
  const authorizePreparedInput = options.authorizePreparedInput;
  text(options.ownerId);
  if (options.catalog.databaseSchema !== options.schema) {
    throw new TypeError("Child Action catalog schema does not match.");
  }
  const maxPending = options.maxPendingDeliveries ?? 128;
  const maxDepth = options.maxDepth ?? 32;
  if (
    ![maxPending, maxDepth].every((value) =>
      Number.isSafeInteger(value) && value > 0
    )
  ) {
    throw new TypeError("Child Action bounds must be positive safe integers.");
  }
  const tables = createCoreTableNames(options.schema);
  const operations = createOperationCatalogTables(options.schema);
  const authorized = new WeakMap<
    SqlExecutor,
    {
      parent: OwnerChildActionParent;
      input?: ChildInput;
      reference?: OwnerChildActionReference;
      action: AnyActionDefinition;
    }
  >();
  const readStore = (tx: SqlExecutor) =>
    createEventStore({
      schema: options.schema,
      session: {
        query: tx.query.bind(tx),
        transaction() {
          throw new TypeError("Child Action reads cannot open transactions.");
        },
      },
    });
  function actionById(id: string): AnyActionDefinition {
    const found = Object.values(options.registry.actions).filter((action) =>
      action.id === id
    );
    if (found.length !== 1) {
      throw new TypeError("Unknown registered child Action.");
    }
    const action = found[0];
    if (
      action.content || action.resolve || actionDefinitionHasSecrets(action)
    ) {
      throw new TypeError(
        "Child Actions do not yet support protected/content/deferred definitions.",
      );
    }
    return action;
  }
  async function lifecycle(tx: SqlExecutor, event: DurableEvent) {
    const body = json(
      await readEventBody(
        { transaction: tx, tables },
        event.namespace,
        eventDataRef(event.payload),
      ),
    );
    ordinary(body);
    const parsed = parseActionLifecycleEvent({ ...event, data: body });
    if (!parsed) unavailable();
    return parsed;
  }
  async function current(
    tx: SqlExecutor,
    caller: OwnerCaller,
    ref: OwnerChildActionParentReference,
    time: string,
  ): Promise<OwnerChildActionParent> {
    const found = await options.resolveParent(
      tx,
      structuredClone(caller),
      time,
    );
    if (!found) refuse();
    const binding = structuredClone(found);
    const a = binding.assignment;
    if (
      a.ownerId !== options.ownerId || caller.principal.kind !== "worker" ||
      a.workerId !== caller.principal.workerId ||
      a.assignmentId !== caller.assignmentId ||
      a.sessionId !== caller.sessionId ||
      a.dispatchAttemptId !== caller.dispatchAttemptId ||
      a.ctxGranted !== true || a.deliveryId !== ref.deliveryId ||
      a.dispatchAttemptId !== ref.dispatchAttemptId
    ) refuse();
    const store = readStore(tx);
    const initial = await store.getDelivery(a.deliveryId);
    if (!initial) refuse();
    const scope =
      (await tx.query<{ state: string; cancellation_requested_at: unknown }>(
        `SELECT state,cancellation_requested_at FROM ${operations.operations} WHERE namespace=$1 AND operation_id=$2 FOR UPDATE`,
        [a.namespace, initial.settlementScopeId],
      )).rows[0];
    if (
      !scope || !["accepted", "running"].includes(scope.state) ||
      scope.cancellation_requested_at != null
    ) refuse();
    await tx.query(
      `SELECT id FROM ${tables.event_deliveries} WHERE id=$1 FOR UPDATE`,
      [a.deliveryId],
    );
    const delivery = await store.getDelivery(a.deliveryId);
    const source = delivery && await store.getEvent(delivery.eventId);
    if (
      !delivery || !source || source.ownerId !== options.ownerId ||
      source.namespace !== a.namespace ||
      delivery.settlementScopeId !== initial.settlementScopeId ||
      delivery.status !== "leased" ||
      delivery.leaseOwner !== a.dispatchAttemptId ||
      !(Date.parse(delivery.leaseExpiresAt ?? "") > Date.parse(time))
    ) refuse();
    if (binding.kind === "processor") {
      if (
        source.id !== binding.assignment.sourceEventId ||
        delivery.consumerId !== `processor:${binding.assignment.processorId}` ||
        ref.operationKey !== `delivery:${delivery.id}`
      ) refuse();
      return {
        namespace: a.namespace,
        operationKey: ref.operationKey,
        rootKey: ref.operationKey,
        originalMetadata: object(source.metadata),
        source,
        delivery,
        depth: 0,
      };
    }
    const assignment = binding.assignment;
    const runId = assignment.invocation.actionRunId;
    if (
      delivery.consumerId !== `registered:${assignment.actionId}` ||
      source.metadata.actionId !== assignment.actionId ||
      source.metadata.actionRunId !== runId ||
      ref.operationKey !== runId || assignment.invocation.operationKey !== runId
    ) refuse();
    const invoked = await store.getEventByDeduplicationId(
      a.namespace,
      `${runId}:action:invoked`,
    );
    if (
      !invoked || invoked.ownerId !== options.ownerId ||
      invoked.causationId !== source.id ||
      invoked.metadata.sourceDeliveryId !== delivery.id
    ) refuse();
    const captured = await lifecycle(tx, invoked);
    if (
      captured.status !== "invoked" ||
      captured.actionId !== assignment.actionId ||
      captured.actionRunId !== runId
    ) refuse();
    const open = (await tx.query<
      {
        action_id: string;
        owner_delivery_id: string;
        scope_id: string;
        state: string;
      }
    >(
      `SELECT action_id,owner_delivery_id,scope_id,state FROM ${tables.open_actions} WHERE namespace=$1 AND action_run_id=$2 FOR UPDATE`,
      [a.namespace, runId],
    )).rows[0];
    if (
      !open || open.state !== "invoked" ||
      open.action_id !== assignment.actionId ||
      open.owner_delivery_id !== delivery.id ||
      open.scope_id !== delivery.settlementScopeId ||
      await store.getEventByDeduplicationId(
        a.namespace,
        `${runId}:action:terminal`,
      )
    ) refuse();
    const rootKey = source.metadata.rootKey ?? runId;
    text(rootKey);
    if (assignment.invocation.rootKey !== rootKey) refuse();
    const depth = source.metadata.childDepth ?? 0;
    if (
      !Number.isSafeInteger(depth) || Number(depth) < 0 ||
      Number(depth) >= maxDepth
    ) refuse("Child Action nesting limit reached.");
    return {
      namespace: a.namespace,
      operationKey: captured.actionRunId,
      rootKey,
      actionRunId: runId,
      originalMetadata: object(captured.metadata),
      source,
      delivery,
      depth: Number(depth),
    };
  }
  const inputDefinition: OwnerCommandInputDefinition = {
    async normalize(raw) {
      const data = object(raw, [
        "parent",
        "actionAlias",
        "operationKey",
        "input",
      ]);
      const parent = parentReference(data.parent);
      text(data.actionAlias);
      text(data.operationKey);
      const registered =
        Object.hasOwn(options.registry.actions, data.actionAlias)
          ? options.registry.actions[data.actionAlias]
          : undefined;
      if (!registered) throw new TypeError("Unknown registered child Action.");
      const action = actionById(registered.id);
      ordinary(data.input);
      if (!same(data.input, canonicalizeContentRefs(data.input))) {
        throw new TypeError("Child Action input changes when persisted.");
      }
      if (action.inputSchema) {
        validateAgainstJsonSchema(
          action.inputSchema,
          data.input,
          "Action input",
        );
      }
      const value: ChildInput = {
        parent,
        actionAlias: data.actionAlias,
        actionId: action.id,
        operationKey: data.operationKey,
        input: ordered(data.input),
      };
      // Wire delivery/attempt selectors establish no logical identity. Current
      // authorization checks them independently before every receipt lookup.
      const original = ordered({
        parentOperationKey: parent.operationKey,
        actionId: action.id,
        operationKey: data.operationKey,
        input: value.input,
      });
      const digest = await digestContent(
        new TextEncoder().encode(JSON.stringify(original)),
      );
      return {
        intent: { encoding: "copilotz.child-action.v1", digest },
        value,
      };
    },
  };
  async function append(
    parent: OwnerChildActionParent,
    input: ChildInput,
    context: OwnerCommandContext,
    preparation?: OwnerPreparationCapture,
  ): Promise<OwnerChildActionReference> {
    const runId =
      `${parent.operationKey}/action:${input.actionId}:${input.operationKey}`;
    text(runId);
    // Compatible duplicates are resolved by their authorized command receipt.
    // Never adopt another ordinary/prepared admission's existing input body.
    if (
      await readStore(context.tx).getEventByDeduplicationId(
        parent.namespace,
        runId,
      )
    ) {
      refuse("Child Action input already belongs to another admission.");
    }
    const count = (await context.tx.query<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM (SELECT 1 FROM ${tables.event_deliveries} WHERE status IN ('pending','leased','retry_wait') LIMIT $1) pending`,
      [maxPending],
    )).rows[0];
    if (!count || Number(count.count) >= maxPending) {
      throw Object.assign(
        new Error("Child Action delivery capacity is full."),
        { code: "owner_admission_refused" },
      );
    }
    const bodyId = await deriveWorkflowId("action-input", runId);
    const store = createEventStore({
      schema: options.schema,
      session: options.session,
      ownerCommit: context.ownerCommit,
      lockSettlementScope: (tx, scope) => options.catalog.lockScope(tx, scope),
      admitOperationEventSql: (value, param) =>
        options.catalog.admitEventSql(value, param),
      indexOperationEventSql: (value, param) =>
        options.catalog.indexEventSql(value, param),
      indexOperationEvent: (tx, value) => options.catalog.indexEvent(tx, value),
    });
    const result = await store.commitMutation({
      transaction: context.tx,
      draft: {
        type: "copilotz.owner.action.requested",
        namespace: parent.namespace,
        payload: {
          dataRef: {
            eventBodyId: bodyId,
            schemaVersion: 1,
            mediaType: "application/json",
          },
        },
        metadata: {
          actionId: input.actionId,
          actionRunId: runId,
          actionMetadata: {},
          parentOperationKey: parent.operationKey,
          parentDeliveryId: parent.delivery.id,
          localOperationKey: input.operationKey,
          rootKey: parent.rootKey,
          childDepth: parent.depth + 1,
          ...(preparation ? { [OWNER_PREPARATION_METADATA]: preparation } : {}),
          ...(parent.actionRunId
            ? { parentActionRunId: parent.actionRunId }
            : {}),
        },
        deduplicationId: runId,
        causationId: parent.source.id,
        correlationId: parent.source.correlationId,
        settlementScopeId: parent.delivery.settlementScopeId,
        ...(parent.delivery.actionScopeId
          ? { actionScopeId: parent.delivery.actionScopeId }
          : {}),
        deliveryLease: {
          deliveryId: parent.delivery.id,
          owner: input.parent.dispatchAttemptId,
        },
      },
      body: { id: bodyId, json: input.input },
      consumers: [{
        consumerId: `registered:${input.actionId}`,
        settlement: "inherit",
      }],
    });
    const reference: OwnerChildActionReference = {
      namespace: parent.namespace,
      actionId: input.actionId,
      executionId: runId,
      eventId: result.event.id,
      deliveryId: result.deliveries[0].id,
    };
    if (preparation) {
      await guardPrepared(
        context.tx,
        result.event,
        result.deliveries[0],
        context.caller,
        "input",
        context.commandTime,
        context.signal,
      );
    }
    context.signal.throwIfAborted();
    context.afterCommit(() => options.schedule(structuredClone(reference)));
    return reference;
  }
  const handler: OwnerCommandHandler = async (_intent, context) => {
    const state = authorized.get(context.tx);
    authorized.delete(context.tx);
    if (!state?.input || !same(context.input, state.input)) refuse();
    return await append(state.parent, state.input, context);
  };
  async function guardPrepared(
    tx: SqlExecutor,
    source: DurableEvent,
    delivery: EventDelivery,
    caller: OwnerCaller,
    purpose: "input" | "result",
    commandTime: string,
    signal: AbortSignal,
  ): Promise<void> {
    const capture = preparationCaptureFromMetadata(source.metadata);
    if (!capture) return;
    if (!authorizePreparedInput) {
      refuse("Prepared input authority is unavailable.");
    }
    signal.throwIfAborted();
    await authorizePreparedInput(tx, {
      caller: structuredClone(caller),
      sourceEventId: source.id,
      deliveryId: delivery.id,
      actionId: String(source.metadata.actionId),
      namespace: source.namespace,
      purpose,
      commandTime,
      signal: AbortSignal.any([signal]),
    });
    signal.throwIfAborted();
  }
  async function inspect(
    tx: SqlExecutor,
    parent: OwnerChildActionParent,
    ref: OwnerChildActionReference,
  ): Promise<{ source: DurableEvent; delivery: EventDelivery }> {
    const store = readStore(tx);
    const source = await store.getEvent(ref.eventId);
    const delivery = await store.getDelivery(ref.deliveryId);
    if (
      !source || !delivery || source.ownerId !== options.ownerId ||
      source.namespace !== parent.namespace ||
      ref.namespace !== parent.namespace ||
      source.type !== "copilotz.owner.action.requested" ||
      source.metadata.actionId !== ref.actionId ||
      source.metadata.actionRunId !== ref.executionId ||
      source.deduplicationId !== ref.executionId ||
      source.metadata.parentOperationKey !== parent.operationKey ||
      source.metadata.parentDeliveryId !== parent.delivery.id ||
      source.causationId !== parent.source.id ||
      source.metadata.parentActionRunId !== parent.actionRunId ||
      source.correlationId !== parent.source.correlationId ||
      delivery.eventId !== source.id ||
      delivery.consumerId !== `registered:${ref.actionId}` ||
      delivery.settlementScopeId !== parent.delivery.settlementScopeId ||
      delivery.actionScopeId !== parent.delivery.actionScopeId
    ) unavailable();
    const local = source.metadata.localOperationKey;
    text(local);
    if (
      ref.executionId !==
        `${parent.operationKey}/action:${ref.actionId}:${local}`
    ) unavailable();
    return { source, delivery };
  }
  const projection: OwnerProjectionHandler = async (
    _input,
    context,
  ): Promise<OwnerJson> => {
    const state = authorized.get(context.tx);
    authorized.delete(context.tx);
    if (!state?.reference) unavailable();
    const { parent, reference: ref, action } = state;
    const store = readStore(context.tx);
    const { source, delivery } = await inspect(context.tx, parent, ref);
    await guardPrepared(
      context.tx,
      source,
      delivery,
      context.caller,
      "result",
      context.commandTime,
      context.signal,
    );
    const event = await store.getEventByDeduplicationId(
      ref.namespace,
      `${ref.executionId}:action:terminal`,
    );
    let terminal;
    if (event) {
      if (
        event.ownerId !== options.ownerId || event.causationId !== source.id ||
        event.correlationId !== source.correlationId ||
        event.metadata.sourceDeliveryId !== delivery.id
      ) unavailable();
      terminal = await lifecycle(context.tx, event);
      if (
        terminal.actionId !== ref.actionId ||
        terminal.actionRunId !== ref.executionId ||
        terminal.parentActionRunId !== parent.actionRunId ||
        !["completed", "failed", "cancelled"].includes(terminal.status)
      ) unavailable();
    }
    let result: OwnerJson;
    if (delivery.status === "cancelled" || terminal?.status === "cancelled") {
      result = { status: "cancelled", code: "action_cancelled" };
    } else if (
      delivery.status === "dead_letter" || terminal?.status === "failed"
    ) {
      result = { status: "failed", code: "action_failed" };
    } else if (
      !terminal && ["pending", "leased", "retry_wait"].includes(delivery.status)
    ) {
      result = { status: "pending" };
    } else if (
      !terminal || terminal.status !== "completed" ||
      delivery.status !== "succeeded"
    ) {
      result = { status: "failed", code: "action_not_completed" };
    } else {
      const output = json(terminal.output);
      ordinary(output);
      if (action.outputSchema) {
        validateAgainstJsonSchema(action.outputSchema, output, "Action output");
      }
      result = { status: "completed", output };
    }
    await guardPrepared(
      context.tx,
      source,
      delivery,
      context.caller,
      "result",
      context.commandTime,
      context.signal,
    );
    return result;
  };
  async function authorizeTarget(
    tx: SqlExecutor,
    caller: OwnerCaller,
    ref: OwnerChildActionParentReference,
    actionAlias: string,
    operationKey: string,
    time: string,
  ) {
    text(actionAlias);
    text(operationKey);
    const parent = await current(
      tx,
      structuredClone(caller),
      parentReference(ref),
      time,
    );
    const registered = Object.hasOwn(options.registry.actions, actionAlias)
      ? options.registry.actions[actionAlias]
      : undefined;
    if (!registered) throw new TypeError("Unknown registered child Action.");
    const action = actionById(registered.id);
    await options.authorizeChild(
      tx,
      structuredClone(caller),
      structuredClone(parent),
      action.id,
      time,
    );
    return { parent: structuredClone(parent), actionId: action.id };
  }
  return {
    authorizeTarget,
    async inspectPrepared(
      tx: SqlExecutor,
      caller: OwnerCaller,
      ref: OwnerChildActionParentReference,
      reference: OwnerChildActionReference,
      time: string,
    ): Promise<DurableEvent> {
      if (!authorizePreparedInput) {
        refuse("Prepared input authority is unavailable.");
      }
      const parent = await current(
        tx,
        structuredClone(caller),
        parentReference(ref),
        time,
      );
      const parsed = childReference(reference);
      const action = actionById(parsed.actionId);
      await options.authorizeChild(
        tx,
        structuredClone(caller),
        structuredClone(parent),
        action.id,
        time,
      );
      const { source } = await inspect(tx, parent, parsed);
      if (!preparationCaptureFromMetadata(source.metadata)) {
        refuse("Prepared input is absent.");
      }
      return structuredClone(source);
    },
    async admitPrepared(
      raw: Readonly<
        {
          parent: OwnerChildActionParentReference;
          actionAlias: string;
          operationKey: string;
          input: OwnerJson;
          preparation: OwnerPreparationCapture;
        }
      >,
      context: OwnerCommandContext,
    ): Promise<OwnerChildActionReference> {
      if (!authorizePreparedInput) {
        refuse("Prepared input authority is unavailable.");
      }
      const preparation = parseOwnerPreparationCapture(raw.preparation);
      const normalized = await inputDefinition.normalize({
        parent: raw.parent,
        actionAlias: raw.actionAlias,
        operationKey: raw.operationKey,
        input: raw.input,
      });
      const input = normalized.value as ChildInput;
      const target = await authorizeTarget(
        context.tx,
        context.caller,
        input.parent,
        input.actionAlias,
        input.operationKey,
        context.commandTime,
      );
      if (
        target.actionId !== input.actionId ||
        preparation.source.source.namespace !== target.parent.namespace
      ) {
        refuse();
      }
      context.signal.throwIfAborted();
      return await append(target.parent, input, context, preparation);
    },
    inputDefinition,
    handler,
    projection,
    async authorize(
      tx: SqlExecutor,
      caller: OwnerCaller,
      command: OwnerCommand,
      time: string,
      normalizedInput?: OwnerJson,
    ) {
      authorized.delete(tx);
      if (command.kind === OWNER_CHILD_ACTION_ADMISSION) {
        const input = object(normalizedInput, [
          "parent",
          "actionAlias",
          "actionId",
          "operationKey",
          "input",
        ]) as ChildInput;
        const parent = await current(
          tx,
          caller,
          parentReference(input.parent),
          time,
        );
        const action = actionById(input.actionId);
        if (
          command.domain !== "logical" ||
          command.key !==
            ownerChildActionKey(
              options.ownerId,
              parent.namespace,
              parent.operationKey,
              action.id,
              input.operationKey,
            )
        ) refuse("Child Action identity is not bound to its current parent.");
        await options.authorizeChild(
          tx,
          structuredClone(caller),
          structuredClone(parent),
          action.id,
          time,
        );
        const original = await readStore(tx).getEventByDeduplicationId(
          parent.namespace,
          `${parent.operationKey}/action:${action.id}:${input.operationKey}`,
        );
        if (
          original &&
          Object.hasOwn(original.metadata, OWNER_PREPARATION_METADATA)
        ) {
          refuse("Prepared input cannot be adopted by ordinary admission.");
        }
        authorized.set(tx, { parent, input, action });
      } else if (
        command.kind === OWNER_CHILD_ACTION_RESULT &&
        command.domain === "occurrence"
      ) {
        const value = object(command.intent, ["parent", "reference"]);
        const parent = await current(
          tx,
          caller,
          parentReference(value.parent),
          time,
        );
        const reference = childReference(value.reference);
        if (reference.namespace !== parent.namespace) unavailable();
        const action = actionById(reference.actionId);
        await options.authorizeChild(
          tx,
          structuredClone(caller),
          structuredClone(parent),
          action.id,
          time,
        );
        authorized.set(tx, { parent, reference, action });
      } else throw new TypeError("Unknown child Action command.");
    },
  };
}
