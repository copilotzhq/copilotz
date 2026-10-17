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
import {
  encodeEventBody,
  eventDataRef,
  readEventBody,
} from "../events/body-store.ts";
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
  parseOwnerChildActionParentReference,
} from "../execution/child-action-port.ts";
import { assertJsonValue } from "../json.ts";
import { isOwnerProtectedSchemaFamily } from "./ordinary-value.ts";
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
import type { OwnerExecutionAssignment } from "./execution.ts";
import type {
  OwnerLocalProcessorAssignment,
  OwnerProcessorAssignment,
} from "./processor.ts";
import {
  assertOwnerAttemptCaller,
  type OwnerAttemptAuthority,
  ownerAttemptIsLive,
  ownerAttemptToken,
  ownerEventCommitForAttempt,
} from "./attempt-authority.ts";
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
  | Readonly<{ kind: "action"; assignment: OwnerExecutionAssignment }>
  | Readonly<
    {
      kind: "processor";
      assignment: OwnerProcessorAssignment | OwnerLocalProcessorAssignment;
    }
  >;
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
function ordinary(value: OwnerJson, schemaValue = false): void {
  if (typeof value === "string") {
    if (schemaValue && isOwnerProtectedSchemaFamily(value)) {
      throw new TypeError("Child Actions support ordinary JSON only.");
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  if (isContentRef(value)) {
    throw new TypeError("Child Actions support ordinary JSON only.");
  }
  const array = Array.isArray(value);
  for (const [key, child] of Object.entries(value)) {
    ordinary(child, key === "schema" || (array && schemaValue));
  }
}
const parentReference = parseOwnerChildActionParentReference;
function attemptAuthority(
  binding: OwnerChildActionBinding,
): OwnerAttemptAuthority {
  const a = binding.assignment;
  if ("placement" in a) return a;
  if (binding.kind !== "processor") refuse("Action placement is required.");
  return { ...a, placement: "worker" };
}
function assertParentSelector(
  ref: OwnerChildActionParentReference,
  binding: OwnerChildActionBinding,
): void {
  const authority = attemptAuthority(binding);
  const local = authority.placement === "owner-local";
  if (
    ref.deliveryId !== authority.deliveryId || local !== ("placement" in ref) ||
    ownerAttemptToken(authority) !==
      ("placement" in ref ? ref.attemptId : ref.dispatchAttemptId)
  ) refuse();
}
function requireWorkerParent(ref: OwnerChildActionParentReference): void {
  if ("placement" in parentReference(ref)) {
    refuse("Local named preparation is unavailable.");
  }
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
    /** Exact private caller/attempt lifetime after the last await. This does
     * not replace SQL grant/input checks. Only a synchronous literal true admits. */
    isCurrentParent(
      caller: OwnerCaller,
      binding: OwnerChildActionBinding,
    ): boolean;
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
  const isCurrentParent = options.isCurrentParent;
  if (typeof isCurrentParent !== "function") {
    throw new TypeError("A private current-parent witness is required.");
  }
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
      binding: OwnerChildActionBinding;
      parentRef: OwnerChildActionParentReference;
      input?: ChildInput;
      reference?: OwnerChildActionReference;
      action: AnyActionDefinition;
    }
  >();
  type ParentProof = Readonly<{
    bodies: string;
    leaseExpiresAt: string | null;
    invokedEventId: string | null;
    parent: OwnerChildActionParent;
    binding: OwnerChildActionBinding;
  }>;
  const parentProofs = new WeakMap<OwnerChildActionParent, ParentProof>();
  async function captureBody(tx: SqlExecutor, event: DurableEvent) {
    const ref = eventDataRef(event.payload);
    const body = json(
      await readEventBody({ transaction: tx, tables }, event.namespace, ref),
    );
    const encoded = await encodeEventBody(body);
    return {
      namespace: event.namespace,
      id: ref.eventBodyId,
      schema: ref.schemaVersion,
      body: JSON.parse(encoded.body) as OwnerJson,
      digest: encoded.digest,
    };
  }
  const currentBindings = new WeakMap<SqlExecutor, OwnerChildActionBinding>();
  const authorizationProofs = new WeakMap<
    SqlExecutor,
    {
      caller: OwnerCaller;
      command: OwnerCommand;
      time: string;
      binding: OwnerChildActionBinding;
    }
  >();
  function privateCurrent(
    caller: OwnerCaller,
    binding: OwnerChildActionBinding,
  ): void {
    let answer: unknown;
    try {
      answer = isCurrentParent(
        structuredClone(caller),
        structuredClone(binding),
      );
      if (answer instanceof Promise) {
        Promise.prototype.then.call(answer, undefined, () => undefined);
      }
    } catch {
      refuse();
    }
    if (answer !== true) refuse();
  }
  function currentBinding(tx: SqlExecutor): OwnerChildActionBinding {
    const binding = currentBindings.get(tx);
    if (!binding) refuse();
    return structuredClone(binding);
  }
  function bindAuthorization(
    tx: SqlExecutor,
    caller: OwnerCaller,
    command: OwnerCommand,
    time: string,
    binding: OwnerChildActionBinding,
  ) {
    privateCurrent(caller, binding);
    authorizationProofs.set(tx, {
      caller: structuredClone(caller),
      command: structuredClone(command),
      time,
      binding: structuredClone(binding),
    });
  }
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
    currentBindings.delete(tx);
    const found = await options.resolveParent(
      tx,
      structuredClone(caller),
      time,
    );
    if (!found) refuse();
    const binding = structuredClone(found);
    privateCurrent(caller, binding);
    const bodyProofs: Awaited<ReturnType<typeof captureBody>>[] = [];
    let invokedEventId: string | null = null;
    const remember = async (parent: OwnerChildActionParent) => {
      parentProofs.set(parent, {
        bodies: JSON.stringify(bodyProofs),
        leaseExpiresAt,
        invokedEventId,
        parent: structuredClone(parent),
        binding: structuredClone(binding),
      });
      await recheckParent(tx, caller, ref, time, parent, binding);
      privateCurrent(caller, binding);
      currentBindings.set(tx, structuredClone(binding));
      return parent;
    };
    const a = binding.assignment;
    const authority = attemptAuthority(binding);
    assertOwnerAttemptCaller(caller, authority, options.ownerId);
    assertParentSelector(ref, binding);
    if (a.ctxGranted !== true) refuse();
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
    const locked = (await tx.query<{ lease_expires_at: string | null }>(
      `SELECT lease_expires_at::text AS lease_expires_at FROM ${tables.event_deliveries} WHERE id=$1 FOR UPDATE`,
      [a.deliveryId],
    )).rows[0];
    if (
      !locked || (authority.placement === "worker" && !locked.lease_expires_at)
    ) refuse();
    const leaseExpiresAt = locked.lease_expires_at;
    const delivery = await store.getDelivery(a.deliveryId);
    const source = delivery && await store.getEvent(delivery.eventId);
    if (
      !delivery || !source || source.ownerId !== options.ownerId ||
      source.namespace !== a.namespace ||
      delivery.settlementScopeId !== initial.settlementScopeId ||
      !ownerAttemptIsLive(delivery, authority, time)
    ) refuse();
    bodyProofs.push(await captureBody(tx, source));
    if (binding.kind === "processor") {
      if (
        source.id !== binding.assignment.sourceEventId ||
        delivery.consumerId !== `processor:${binding.assignment.processorId}` ||
        ref.operationKey !== `delivery:${delivery.id}` ||
        ("placement" in binding.assignment &&
          binding.assignment.attemptOrdinal !== delivery.attempts)
      ) refuse();
      return remember({
        namespace: a.namespace,
        operationKey: ref.operationKey,
        rootKey: ref.operationKey,
        originalMetadata: object(source.metadata),
        source,
        delivery,
        depth: 0,
      });
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
    const invokedBody = await captureBody(tx, invoked);
    bodyProofs.push(invokedBody);
    invokedEventId = invoked.id;
    ordinary(invokedBody.body);
    const captured = parseActionLifecycleEvent({
      ...invoked,
      data: invokedBody.body,
    });
    if (!captured) refuse();
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
    return remember({
      namespace: a.namespace,
      operationKey: captured.actionRunId,
      rootKey,
      actionRunId: runId,
      originalMetadata: object(captured.metadata),
      source,
      delivery,
      depth: Number(depth),
    });
  }
  async function recheckParent(
    tx: SqlExecutor,
    caller: OwnerCaller,
    ref: OwnerChildActionParentReference,
    time: string,
    parent: OwnerChildActionParent,
    binding: OwnerChildActionBinding,
  ): Promise<void> {
    // Reauthorize current parent grant/input policy as well as the private
    // Started lifetime. The synchronous witness alone is not business policy.
    const returned = await options.resolveParent(
      tx,
      structuredClone(caller),
      time,
    );
    if (!returned || !same(returned, binding)) refuse();
    privateCurrent(caller, binding);
    const a = binding.assignment;
    const authority = attemptAuthority(binding);
    assertOwnerAttemptCaller(caller, authority, options.ownerId);
    assertParentSelector(ref, binding);
    if (ref.operationKey !== parent.operationKey) refuse();
    const proof = parentProofs.get(parent);
    if (
      !proof || !same(proof.parent, parent) || !same(proof.binding, binding)
    ) refuse();
    // Body rows are mutable. Compare the initially verified bodies in SQL,
    // together with exact lease and open-Action facts, after every awaited policy.
    // At most two bounded bodies are captured; repeated checks return a boolean.
    const row = (await tx.query<
      {
        facts_current: boolean;
        event_id: string;
        consumer_id: string;
        settlement_scope_id: string;
        action_scope_id: string | null;
        status: string;
        attempts: number;
        lease_owner: string | null;
        lease_expires_at: string | null;
        source_owner: string;
        source_namespace: string;
        operation_state: string;
        cancellation_requested_at: unknown;
      }
    >(
      `SELECT (
         d.max_attempts=$3 AND d.lease_expires_at IS NOT DISTINCT FROM $4::timestamptz
         AND (($10::boolean AND d.lease_expires_at IS NULL) OR
           (NOT $10::boolean AND d.lease_expires_at>$5::timestamptz))
         AND NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements($6::jsonb) expected
           LEFT JOIN ${tables.event_bodies} b ON b.namespace=expected->>'namespace' AND b.event_body_id=expected->>'id'
           WHERE b.event_body_id IS NULL OR b.schema_version<>(expected->>'schema')::int
             OR b.body IS DISTINCT FROM expected->'body' OR b.digest IS DISTINCT FROM expected->>'digest'
         )
         AND ($7::text IS NULL OR (
           EXISTS (SELECT 1 FROM ${tables.open_actions} oa WHERE oa.namespace=$2 AND oa.action_run_id=$7
             AND oa.action_id=$8 AND oa.owner_delivery_id=d.id AND oa.scope_id=d.settlement_scope_id
             AND oa.action_scope_id IS NOT DISTINCT FROM d.action_scope_id
             AND oa.invoked_event_id=$9 AND oa.state='invoked')
           AND NOT EXISTS (SELECT 1 FROM ${tables.events} terminal WHERE terminal.namespace=$2 AND terminal.deduplication_id=$7 || ':action:terminal')
         ))
       ) AS facts_current, d.event_id,d.consumer_id,d.settlement_scope_id,d.action_scope_id,d.status,d.attempts,d.lease_owner,d.lease_expires_at::text AS lease_expires_at,e.owner_id AS source_owner,e.namespace AS source_namespace,o.state AS operation_state,o.cancellation_requested_at
       FROM ${tables.event_deliveries} d JOIN ${tables.events} e ON e.id=d.event_id
       JOIN ${operations.operations} o ON o.namespace=$2 AND o.operation_id=d.settlement_scope_id WHERE d.id=$1`,
      [
        a.deliveryId,
        parent.namespace,
        parent.delivery.maxAttempts,
        proof.leaseExpiresAt,
        time,
        proof.bodies,
        parent.actionRunId ?? null,
        binding.kind === "action" ? binding.assignment.actionId : null,
        proof.invokedEventId,
        authority.placement === "owner-local",
      ],
    )).rows[0];
    if (
      !row || row.facts_current !== true ||
      row.source_owner !== options.ownerId ||
      row.source_namespace !== parent.namespace ||
      row.event_id !== parent.source.id ||
      row.consumer_id !== parent.delivery.consumerId ||
      row.settlement_scope_id !== parent.delivery.settlementScopeId ||
      row.action_scope_id !== (parent.delivery.actionScopeId ?? null) ||
      row.status !== "leased" || row.attempts !== parent.delivery.attempts ||
      row.lease_owner !== ownerAttemptToken(authority) ||
      (binding.kind === "processor" && "placement" in binding.assignment &&
        row.attempts !== binding.assignment.attemptOrdinal) ||
      !["accepted", "running"].includes(row.operation_state) ||
      row.cancellation_requested_at != null
    ) refuse();
    privateCurrent(caller, binding);
    currentBindings.set(tx, structuredClone(binding));
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
    const binding = currentBinding(context.tx);
    await recheckParent(
      context.tx,
      context.caller,
      input.parent,
      context.commandTime,
      parent,
      binding,
    );
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
    privateCurrent(context.caller, binding);
    const store = createEventStore({
      schema: options.schema,
      session: options.session,
      ownerCommit: ownerEventCommitForAttempt(
        context,
        attemptAuthority(binding),
      ),
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
          owner: ownerAttemptToken(attemptAuthority(binding)),
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
    await recheckParent(
      context.tx,
      context.caller,
      input.parent,
      context.commandTime,
      parent,
      binding,
    );
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
    const { parent, reference: ref, action, binding, parentRef } = state;
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
    await recheckParent(
      context.tx,
      context.caller,
      parentRef,
      context.commandTime,
      parent,
      binding,
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
    await recheckParent(
      context.tx,
      context.caller,
      parentRef,
      context.commandTime,
      parent,
      binding,
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
    requireWorkerParent(ref);
    text(actionAlias);
    text(operationKey);
    const parent = await current(
      tx,
      structuredClone(caller),
      parentReference(ref),
      time,
    );
    const binding = currentBinding(tx);
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
    await recheckParent(tx, caller, ref, time, parent, binding);
    const detached = structuredClone(parent);
    parentProofs.set(detached, parentProofs.get(parent)!);
    return { parent: detached, actionId: action.id };
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
      requireWorkerParent(ref);
      if (!authorizePreparedInput) {
        refuse("Prepared input authority is unavailable.");
      }
      const parent = await current(
        tx,
        structuredClone(caller),
        parentReference(ref),
        time,
      );
      const binding = currentBinding(tx);
      const parsed = childReference(reference);
      const action = actionById(parsed.actionId);
      await options.authorizeChild(
        tx,
        structuredClone(caller),
        structuredClone(parent),
        action.id,
        time,
      );
      await recheckParent(tx, caller, ref, time, parent, binding);
      const { source } = await inspect(tx, parent, parsed);
      if (!preparationCaptureFromMetadata(source.metadata)) {
        refuse("Prepared input is absent.");
      }
      privateCurrent(caller, binding);
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
      requireWorkerParent(raw.parent);
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
    isCurrentAuthorization(
      tx: SqlExecutor,
      caller: OwnerCaller,
      command: OwnerCommand,
      time: string,
    ): boolean {
      const proof = authorizationProofs.get(tx);
      try {
        if (
          !proof || proof.time !== time || !same(proof.caller, caller) ||
          !same(proof.command, command)
        ) return false;
        privateCurrent(caller, proof.binding);
        return authorizationProofs.get(tx) === proof;
      } catch {
        authorizationProofs.delete(tx);
        return false;
      }
    },
    async authorize(
      tx: SqlExecutor,
      caller: OwnerCaller,
      command: OwnerCommand,
      time: string,
      normalizedInput?: OwnerJson,
    ) {
      authorized.delete(tx);
      authorizationProofs.delete(tx);
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
        const binding = currentBinding(tx);
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
        await recheckParent(tx, caller, input.parent, time, parent, binding);
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
        privateCurrent(caller, binding);
        bindAuthorization(tx, caller, command, time, binding);
        authorized.set(tx, {
          parent,
          binding,
          parentRef: structuredClone(input.parent),
          input,
          action,
        });
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
        const binding = currentBinding(tx);
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
        const parentRef = parentReference(value.parent);
        await recheckParent(tx, caller, parentRef, time, parent, binding);
        bindAuthorization(tx, caller, command, time, binding);
        authorized.set(tx, { parent, binding, parentRef, reference, action });
      } else throw new TypeError("Unknown child Action command.");
    },
  };
}
