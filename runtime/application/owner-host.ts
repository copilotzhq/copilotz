/** Private fresh-schema ordinary Action host. Every worker, including embedded
 * workers, uses the same Oxian transport. Restart/takeover, Processors, streams,
 * protected/content/deferred Actions and general reads are deliberately refused. */
import type {
  Hypervisor,
  HypervisorOptions,
} from "../../dependencies/oxian-hypervisor.ts";
import { actionDefinitionHasSecrets } from "../actions/secret.ts";
import {
  createCoreTableNames,
  provisionCopilotzSchema,
  quoteEventIdentifier,
  validateCopilotzSchema,
} from "../events/schema.ts";
import { deriveWorkflowId } from "../events/workflow-id.ts";
import type { SqlExecutor, SqlSession } from "../events/session.ts";
import type { DeliveryExecutor } from "../execution/types.ts";
import { assertJsonValue } from "../json.ts";
import type { PluginRegistry } from "../plugins/registry.ts";
import {
  createOperationCatalog,
  createOperationCatalogTables,
  type OperationSettlementScope,
  provisionOperationCatalog,
  validateOperationCatalog,
} from "../streams/catalog.ts";
import {
  createOwnerActionAdmission,
  OWNER_ACTION_ADMISSION,
  ownerActionAdmissionKey,
  type OwnerActionAdmissionValue,
  validateOwnerActionAdmissionIdentity,
} from "../owner/admission.ts";
import {
  createOwnerActionResultProjection,
  type OwnerAdmittedAction,
} from "../owner/action-result.ts";
import {
  type OwnerAssignmentBinding,
  provisionOwnerAssignments,
  validateOwnerAssignments,
} from "../owner/assignments.ts";
import {
  createOwnerCommandBoundary,
  type OwnerCaller,
  type OwnerCommand,
  type OwnerCommandBoundary,
  type OwnerInputCommand,
  type OwnerJson,
} from "../owner/boundary.ts";
import {
  createOwnerCollectionCommand,
  type OwnerCollectionIntent,
  type OwnerCollectionScope,
} from "../owner/collections.ts";
import {
  createOwnerWorkerCallAdmission,
  type OwnerActionCallRequest,
  type OwnerWorkerCallContext,
} from "../owner/connection.ts";
import { createOwnerEffectCommands } from "../owner/effects.ts";
import type {
  OwnerEffectEvidence,
  OwnerEffectReference,
} from "../owner/effects-client.ts";
import {
  createOwnerExecutionCommands,
  type OwnerExecutionAssignment,
} from "../owner/execution.ts";
import {
  decodeOwnerMetadataConstraints,
  matchesOwnerMetadataConstraints,
  type OwnerMetadataConstraints,
} from "../owner/metadata-constraints.ts";
import {
  ownerTableNames,
  provisionOwnerCommandSchema,
  validateOwnerCommandSchema,
} from "../owner/schema.ts";
import {
  createOwnerOperationSettlement,
  OWNER_OPERATION_READINESS,
  OWNER_OPERATION_SETTLEMENT,
} from "../owner/settlement.ts";
import {
  createOwnerDispatchBridge,
  type OwnerScheduledAssignment,
} from "./owner-dispatch.ts";
import { OWNER_ACTION_WORKLOAD } from "./owner-worker.ts";

type Fence = OwnerWorkerCallContext["fence"];
type JsonObject = Readonly<Record<string, OwnerJson>>;
/** A current host reconstruction, never a worker claim. The original endpoint
 * remains distinct from generic Action exposure, even for the same Action. */
export type OwnerHostIngressScope = Readonly<{
  namespace: string;
  /** Stable authenticated identity, separate from mutable policy/claims. */
  principalKey: string;
  principal: JsonObject;
  route: Readonly<{ kind: "generic" | "wrapper"; id: string }>;
  allowedActions: readonly string[];
  actionMetadata: JsonObject;
  operationMetadata: JsonObject;
  metadataConstraints: OwnerMetadataConstraints;
  group: Readonly<{ key: string; actorId?: string }>;
}>;
export type OwnerHostPolicy = Readonly<{
  /** SQL-only reconstruction of current principal, original endpoint exposure,
   * constraints and bounded group. Undefined denies; no default allow. */
  ingress(
    tx: SqlExecutor,
    input: Readonly<{ fence: Fence; route: "action" | "action-result" }>,
    time: string,
  ):
    | OwnerHostIngressScope
    | undefined
    | Promise<OwnerHostIngressScope | undefined>;
  /** Identity/assignment coordinates come exclusively from the actual transport
   * and private bridge. Callback results can grant capabilities, never rebind. */
  worker(
    tx: SqlExecutor,
    input: Readonly<{ fence: Fence; assignment?: OwnerAssignmentBinding }>,
    time: string,
  ):
    | Readonly<{ ctx: boolean; settlement: boolean }>
    | undefined
    | Promise<Readonly<{ ctx: boolean; settlement: boolean }> | undefined>;
  input(
    tx: SqlExecutor,
    assignment: OwnerExecutionAssignment,
    value: OwnerJson,
    time: string,
  ): void | Promise<void>;
  collections(
    tx: SqlExecutor,
    assignment: OwnerExecutionAssignment,
    intent: OwnerCollectionIntent,
    time: string,
  ):
    | Pick<OwnerCollectionScope, "conditions">
    | Promise<Pick<OwnerCollectionScope, "conditions">>;
  effectOutcome(
    tx: SqlExecutor,
    assignment: OwnerExecutionAssignment,
    ref: OwnerEffectReference,
    value: OwnerJson,
    time: string,
  ): boolean | Promise<boolean>;
  effectNotStarted(
    tx: SqlExecutor,
    assignment: OwnerExecutionAssignment,
    ref: OwnerEffectReference,
    evidence: OwnerEffectEvidence,
    time: string,
  ): boolean | Promise<boolean>;
}>;
type Bridge = ReturnType<typeof createOwnerDispatchBridge>;
type Admissions = ReturnType<Bridge["wrapWorkerCalls"]>;
/** The released Oxian dependency lacks workerCalls. A selected compatible
 * transport factory is mandatory; production pins are not silently replaced. */
export type OwnerHostTransportOptions =
  & Omit<HypervisorOptions, "workerCalls">
  & Readonly<{
    workerCalls:
      & Admissions
      & Readonly<
        { maxConcurrent: number; maxPerConnection: number; timeoutMs: number }
      >;
  }>;
export type OwnerHostOptions = Readonly<{
  ownerId: string;
  holderId: string;
  schema: string;
  session: SqlSession;
  initialization: "fresh";
  registry: PluginRegistry;
  policy: OwnerHostPolicy;
  transport: Omit<HypervisorOptions, "workerCalls">;
  createTransport(
    options: OwnerHostTransportOptions,
    lifecycle: Bridge["lifecycle"] & Readonly<{ onReady(): void }>,
  ): Hypervisor;
  maxPending?: number;
  maxActive?: number;
  leaseMs?: number;
  now?: () => string;
  onError?(error: unknown): void;
}>;
function unavailable(message = "Owner host authority is unavailable."): never {
  throw Object.assign(new Error(message), { code: "owner_host_unavailable" });
}
function text(value: unknown): asserts value is string {
  if (
    typeof value !== "string" || !value.trim() || value !== value.trim() ||
    value.length > 1024
  ) throw new TypeError("Invalid owner host identifier.");
}
function copy<T>(value: T): T {
  assertJsonValue(value, {
    maxDepth: 64,
    maxNodes: 100_000,
    rejectNegativeZero: true,
  });
  return structuredClone(value);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${
      Object.keys(value).sort().map((key) =>
        `${JSON.stringify(key)}:${
          canonical((value as Record<string, unknown>)[key])
        }`
      ).join(",")
    }}`;
  }
  return JSON.stringify(value);
}
function same(a: unknown, b: unknown) {
  return canonical(a) === canonical(b);
}
function uncertain(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as {
    code?: string;
    indeterminate?: boolean;
    outcome?: string;
  };
  return value.indeterminate === true || value.outcome === "unknown" ||
    [
      "owner_commit_unknown",
      "persistence_indeterminate",
      "owner_settlement_unknown",
    ].includes(value.code ?? "");
}
function limit(value: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100_000) {
    throw new TypeError("Invalid owner host capacity.");
  }
  return value;
}
function provenance(scope: OwnerHostIngressScope): JsonObject {
  return copy({
    principalKey: scope.principalKey,
    principal: scope.principal,
    route: scope.route,
    operationMetadata: scope.operationMetadata,
    metadataConstraints: scope.metadataConstraints,
  });
}
/** Returned value is only transport ingress and lifecycle. No database session,
 * boundary, raw dispatcher, assignment authority or readiness setter escapes. */
export async function createOwnerHost(options: OwnerHostOptions) {
  for (const value of [options.ownerId, options.holderId, options.schema]) {
    text(value);
  }
  if (options.initialization !== "fresh") {
    throw new TypeError(
      "Owner host restart/takeover requires concrete recovery integration.",
    );
  }
  for (
    const name of [
      "ingress",
      "worker",
      "input",
      "collections",
      "effectOutcome",
      "effectNotStarted",
    ] as const
  ) {
    if (typeof options.policy?.[name] !== "function") {
      throw new TypeError(`Current owner policy '${name}' is required.`);
    }
  }
  if (typeof options.createTransport !== "function") {
    throw new TypeError(
      "A compatible Oxian worker-call transport factory is required.",
    );
  }
  if (Object.keys(options.registry.processors).length) {
    throw new TypeError("Owner host Processor execution is not implemented.");
  }
  for (const action of Object.values(options.registry.actions)) {
    if (
      action.content || action.resolve || actionDefinitionHasSecrets(action)
    ) throw new TypeError("Owner host supports ordinary JSON Actions only.");
  }
  for (const collection of Object.values(options.registry.collections)) {
    if (collection.content?.fields.length) {
      throw new TypeError(
        "Owner host content Collections are not implemented.",
      );
    }
  }
  const maxPending = limit(options.maxPending ?? 128);
  const maxActive = limit(options.maxActive ?? 16);
  if (maxActive > maxPending) {
    throw new TypeError("Active capacity exceeds pending capacity.");
  }
  const { session, schema, ownerId, holderId, registry, policy } = options;
  const tables = createCoreTableNames(schema);
  const ownerTables = ownerTableNames(schema);
  const operationTables = createOperationCatalogTables(schema);
  const assignmentTable = `${quoteEventIdentifier(schema)}."owner_assignments"`;
  // Explicit fresh provisioning may prepare tables, but NEVER establishes readiness.
  await provisionCopilotzSchema(session, schema);
  await provisionOperationCatalog(session, schema);
  await provisionOwnerCommandSchema(session, schema);
  await provisionOwnerAssignments(session, schema);
  const catalog = createOperationCatalog(session, schema);
  const abort = new AbortController();
  let owner!: OwnerCommandBoundary;
  let transport: Hypervisor | undefined;
  let initialized = false;
  let closed = false;
  let fault: unknown;
  const pending = new Map<string, OwnerScheduledAssignment>();
  const active = new Map<string, Promise<void>>();
  const settlements = new Map<string, OperationSettlementScope>();
  let pumping = false;
  let settlementPump: Promise<void> | undefined;
  let alarmTimer: ReturnType<typeof setTimeout> | undefined;
  let alarmPass: Promise<void> | undefined;
  const controlTokens = new Set<string>();
  type IngressWitness = {
    token: string;
    context: OwnerWorkerCallContext;
    fence: Fence;
    route: "action" | "action-result";
  };
  const ingressContexts = new WeakMap<OwnerWorkerCallContext, IngressWitness>();
  const ingressTokens = new Map<string, IngressWitness>();
  const receiptCalls = new Set<OwnerWorkerCallContext>();
  const collectionScopes = new WeakMap<SqlExecutor, OwnerCollectionScope>();
  const admissionScopes = new WeakMap<SqlExecutor, OwnerHostIngressScope>();
  const preparedScopes = new WeakMap<
    SqlExecutor,
    { scope: OwnerHostIngressScope; request: OwnerActionCallRequest }
  >();
  function report(error: unknown) {
    try {
      options.onError?.(error);
    } catch { /* diagnostics cannot change durability */ }
  }
  function stop(error?: unknown) {
    fault ??= error;
    initialized = false;
    clearTimeout(alarmTimer);
    owner?.stop(error);
    abort.abort(error);
    bridge.stop();
    report(error);
  }
  function ready() {
    return initialized && !closed && owner.state === "acquired" &&
      !abort.signal.aborted;
  }
  function current(fence: Fence): boolean {
    if (!transport || !ready()) return false;
    try {
      return transport.sessions.assertCurrent(copy(fence)).phase === "ready";
    } catch {
      return false;
    }
  }
  async function control<T>(
    run: (caller: OwnerCaller) => Promise<T>,
  ): Promise<T> {
    const token = crypto.randomUUID();
    controlTokens.add(token);
    try {
      return await run({
        workerId: `owner:${ownerId}`,
        ownerEpoch: owner.epoch!,
        hostControl: token,
      });
    } finally {
      controlTokens.delete(token);
    }
  }
  function assertControl(caller: OwnerCaller) {
    if (
      caller.workerId !== `owner:${ownerId}` ||
      caller.ownerEpoch !== owner.epoch ||
      typeof caller.hostControl !== "string" ||
      !controlTokens.has(caller.hostControl)
    ) unavailable();
  }
  const bridge = createOwnerDispatchBridge({
    ownerId,
    schema,
    maxAssignments: maxActive,
    maxWitnesses: maxPending,
    getOwner: () => closed ? undefined : owner,
    sessions: {
      assertCurrent: (fence) => {
        if (!transport) unavailable();
        return transport.sessions.assertCurrent(fence);
      },
    },
    resolveScheduled: (key) => {
      const value = pending.get(key);
      return value && copy(value);
    },
    authorizeControl(_tx, caller) {
      if (!ready() || caller.ownerEpoch !== owner.epoch) unavailable();
    },
  });
  async function scopeFor(
    tx: SqlExecutor,
    caller: OwnerCaller,
    time: string,
  ): Promise<OwnerHostIngressScope> {
    const witness = typeof caller.hostIngress === "string"
      ? ingressTokens.get(caller.hostIngress)
      : undefined;
    if (
      !witness || caller.workerId !== witness.fence.identity.workerId ||
      caller.ownerEpoch !== owner.epoch || !current(witness.fence) ||
      witness.context.signal.aborted
    ) unavailable();
    const result = await policy.ingress(
      tx,
      copy({ fence: witness.fence, route: witness.route }),
      time,
    );
    if (!result || !current(witness.fence) || witness.context.signal.aborted) {
      unavailable();
    }
    const scope = copy(result);
    text(scope.namespace);
    text(scope.principalKey);
    text(scope.route.id);
    text(scope.group.key);
    if (
      !["generic", "wrapper"].includes(scope.route.kind) ||
      !Array.isArray(scope.allowedActions) ||
      !scope.allowedActions.every((alias) =>
        typeof alias === "string" && Object.hasOwn(registry.actions, alias)
      )
    ) unavailable();
    scope.allowedActions.forEach(text);
    const constraints = decodeOwnerMetadataConstraints(
      scope.metadataConstraints,
    );
    if (scope.group.actorId !== undefined) text(scope.group.actorId);
    return { ...scope, metadataConstraints: constraints };
  }
  async function assertIngress(
    tx: SqlExecutor,
    scope: OwnerHostIngressScope,
    value: Pick<
      OwnerActionAdmissionValue,
      "namespace" | "actionId" | "metadata" | "provenance" | "requestId"
    >,
  ) {
    if (
      scope.namespace !== value.namespace ||
      !scope.allowedActions.some((alias) =>
        registry.actions[alias].id === value.actionId
      ) || !same(scope.actionMetadata, value.metadata) ||
      !same(provenance(scope), value.provenance)
    ) unavailable("Current original ingress policy refuses this Action.");
    const runId = await deriveWorkflowId(
      "action",
      ownerId,
      value.namespace,
      value.requestId,
    );
    const existing = (await tx.query<{ metadata: OwnerJson }>(
      `SELECT metadata->'operationMetadata' AS metadata FROM ${tables.events} WHERE owner_id=$1 AND namespace=$2 AND deduplication_id=$3`,
      [ownerId, value.namespace, runId],
    )).rows[0];
    const metadata = existing ? existing.metadata : {
      httpAdmissionKey: scope.group.key,
      ...(scope.group.actorId === undefined
        ? {}
        : { actorId: scope.group.actorId }),
      httpIdempotencyKey: value.requestId,
      ...scope.operationMetadata,
    };
    // Constraints apply to the actual catalog metadata, including reserved
    // group/actor/request fields. A duplicate keeps its originally captured group.
    if (!matchesOwnerMetadataConstraints(scope.metadataConstraints, metadata)) {
      unavailable("Current metadata constraints refuse this operation.");
    }
  }
  async function resolveExecution(
    tx: SqlExecutor,
    caller: OwnerCaller,
    time: string,
  ): Promise<OwnerExecutionAssignment | undefined> {
    const binding = await bridge.resolveStarted(tx, caller);
    if (!binding || "kind" in binding || !ready()) {
      return undefined;
    }
    // The live bridge witness has the exact incarnation. Obtain its fence from
    // the actual session registry; never infer incarnation from worker input.
    const sessionView = transport!.sessions.get(binding.workerId);
    if (!sessionView || sessionView.connectionId !== binding.sessionId) {
      return undefined;
    }
    const fence: Fence = {
      identity: { ...sessionView.identity },
      connectionId: binding.sessionId,
      sessionGeneration: binding.sessionGeneration,
    };
    const returnedGrants = await policy.worker(
      tx,
      copy({ fence, assignment: binding }),
      time,
    );
    const grants = returnedGrants && copy(returnedGrants);
    if (!grants || !await bridge.resolveStarted(tx, caller)) return undefined;
    const source = (await tx.query<
      {
        metadata: Record<string, OwnerJson>;
        namespace: string;
        id: string;
        correlation_id: string;
      }
    >(
      `SELECT id,namespace,metadata,correlation_id FROM ${tables.events} WHERE id=$1 AND owner_id=$2`,
      [binding.sourceEventId, ownerId],
    )).rows[0];
    if (
      !source || source.namespace !== binding.namespace ||
      source.metadata.actionId !== binding.actionId ||
      source.metadata.actionRunId !== binding.executionId
    ) unavailable();
    const metadata = copy(source.metadata.actionMetadata) as JsonObject;
    return {
      ownerId,
      workerId: binding.workerId,
      assignmentId: binding.assignmentId,
      sessionId: binding.sessionId,
      namespace: binding.namespace,
      actionId: binding.actionId,
      deliveryId: binding.deliveryId,
      dispatchAttemptId: binding.dispatchAttemptId,
      ctxGranted: grants.ctx === true,
      settlementGranted: grants.settlement === true,
      invocation: {
        actionRunId: binding.executionId,
        rootKey: binding.executionId,
        operationKey: binding.executionId,
        metadata,
        identity: {
          causationId: source.id,
          correlationId: source.correlation_id,
          settlementScopeId: source.id,
        },
      },
    };
  }
  function enqueue(value: OwnerJson) {
    const data = copy(value) as unknown as {
      namespace: string;
      actionId: string;
      executionId: string;
      eventId: string;
      deliveryId: string;
    };
    if (!ready()) unavailable();
    if (!pending.has(data.deliveryId) && pending.size >= maxPending) {
      unavailable("Owner scheduling queue is full; durable alarm retained.");
    }
    pending.set(data.deliveryId, {
      namespace: data.namespace,
      actionId: data.actionId,
      executionId: data.executionId,
      sourceEventId: data.eventId,
      deliveryId: data.deliveryId,
    });
    queueMicrotask(pump);
  }
  function wake(target: OperationSettlementScope) {
    const key = canonical(target);
    if (!settlements.has(key) && settlements.size >= maxPending) {
      unavailable("Owner settlement queue is full; durable alarm retained.");
    }
    settlements.set(key, copy(target));
    queueMicrotask(() => {
      void pumpSettlements();
    });
  }
  const settlement = createOwnerOperationSettlement({
    ownerId,
    schema,
    session,
    catalog,
    maxConcurrentChecks: maxActive,
    authorizeControl(_tx, caller) {
      assertControl(caller);
      return ready();
    },
    // This host has no stream/output relay capability. Ordinary Action results
    // are persisted JSON projected through action.result, never transport output.
    selectDrains: () => [],
    authorizeDrain: () => false,
    drain: () => Promise.resolve(false),
    wake,
  });
  const executor: DeliveryExecutor = {
    ownership: "injected_dispatcher",
    workload: OWNER_ACTION_WORKLOAD,
    workloads: {},
    scheduleDelivery() {
      unavailable(
        "Processor/child delivery scheduling is not implemented by this host.",
      );
    },
    dispatchWork: () =>
      Promise.reject(new Error("Direct dispatch is not an owner capability.")),
    dispatchDelivery: () =>
      Promise.reject(new Error("Processor execution is unavailable.")),
    dispatchRecoverable: () =>
      Promise.reject(new Error("Restart recovery is unavailable.")),
    settleOutputs: () =>
      Promise.reject(new Error("Stream output is unavailable.")),
    awaitScopeProgress: () => Promise.resolve(false),
    shutdown: () => Promise.resolve(),
  };
  const execution = createOwnerExecutionCommands({
    ownerId,
    schema,
    session,
    registry,
    catalog,
    executor,
    leaseMs: options.leaseMs,
    scheduleSettlement: settlement.schedule,
    resolveAssignment: resolveExecution,
    authorizeInput: (tx, assignment, value, time) =>
      policy.input(tx, copy(assignment), copy(value), time),
  });
  async function effectAssignment(
    tx: SqlExecutor,
    caller: OwnerCaller,
    ref: OwnerEffectReference,
    mode: "begin" | "settlement",
    time: string,
  ) {
    const assignment = mode === "begin"
      ? await execution.authorizeLive(tx, caller, time)
      : await execution.authorizeSettlement(tx, caller, time);
    if (
      assignment.namespace !== ref.namespace ||
      assignment.invocation.actionRunId !== ref.actionRunId
    ) unavailable();
    return assignment;
  }
  const effects = createOwnerEffectCommands({
    ownerId,
    schema,
    async authorizeEffect(tx, caller, ref, mode, time) {
      await effectAssignment(tx, caller, ref, mode, time);
      return true;
    },
    async validateOutcome(tx, caller, ref, value, time) {
      return await policy.effectOutcome(
        tx,
        copy(await effectAssignment(tx, caller, ref, "settlement", time)),
        copy(ref),
        copy(value),
        time,
      ) === true;
    },
    async verifyNotStarted(tx, caller, ref, evidence, time) {
      return await policy.effectNotStarted(
        tx,
        copy(await effectAssignment(tx, caller, ref, "settlement", time)),
        copy(ref),
        copy(evidence),
        time,
      ) === true;
    },
  });
  const admission = createOwnerActionAdmission({
    ownerId,
    schema,
    session,
    registry,
    catalog,
    maxPendingDeliveries: maxPending,
    schedule: enqueue,
    admissionGroup(tx) {
      const scope = admissionScopes.get(tx);
      admissionScopes.delete(tx);
      if (!scope) unavailable();
      return { ...scope.group, metadata: copy(scope.operationMetadata) };
    },
  });
  const result = createOwnerActionResultProjection({
    purpose: "action",
    ownerId,
    schema,
    registry,
    async authorizeCaller(tx, caller, ref, time) {
      const scope = await scopeFor(tx, caller, time);
      if (
        scope.namespace !== ref.namespace ||
        !scope.allowedActions.some((alias) =>
          registry.actions[alias].id === ref.actionId
        )
      ) unavailable();
    },
    async authorizeIngress(tx, caller, admitted: OwnerAdmittedAction, time) {
      await assertIngress(tx, await scopeFor(tx, caller, time), {
        ...admitted.reference,
        requestId: admitted.requestId,
        metadata: admitted.metadata,
        provenance: admitted.provenance,
      });
    },
  });
  const collection = createOwnerCollectionCommand({
    session,
    schema,
    registry,
    collections: registry.collections,
    executor,
    scope(context) {
      const scope = collectionScopes.get(context.tx);
      collectionScopes.delete(context.tx);
      if (!scope) unavailable();
      return scope;
    },
  });
  const deliveryAlarm = (namespace: string, id: string) =>
    JSON.stringify(["host.delivery", namespace, id]);
  owner = createOwnerCommandBoundary({
    session,
    schema,
    ownerId,
    holderId,
    now: options.now,
    maxQueue: maxPending,
    maxPostCommitGroups: maxPending,
    handlers: {
      ...bridge.assignmentHandlers,
      ...execution.handlers,
      ...effects.handlers,
      ...settlement.handlers,
      collections: collection,
      [OWNER_ACTION_ADMISSION]: async (intent, context) => {
        const ref = await admission.handler(intent, context);
        await context.tx.query(
          `INSERT INTO ${ownerTables.alarms}(owner,name,due_at) VALUES($1,$2,$3::timestamptz) ON CONFLICT(owner,name) DO NOTHING`,
          [
            ownerId,
            deliveryAlarm(
              (ref as { namespace: string }).namespace,
              (ref as { deliveryId: string }).deliveryId,
            ),
            context.commandTime,
          ],
        );
        return ref;
      },
      "host.delivery-finished": async (input, context) => {
        const id = (input as { deliveryId: string }).deliveryId;
        const row = (await context.tx.query<
          { status: string; settlement_scope_id: string; namespace: string }
        >(
          `SELECT d.status,d.settlement_scope_id,e.namespace FROM ${tables.event_deliveries} d JOIN ${tables.events} e ON e.id=d.event_id WHERE d.id=$1 AND e.owner_id=$2 FOR UPDATE OF d`,
          [id, ownerId],
        )).rows[0];
        if (
          !row ||
          !["succeeded", "dead_letter", "cancelled"].includes(row.status)
        ) {
          unavailable(
            "Attempt did not reach a durable terminal; recovery is required.",
          );
        }
        await context.tx.query(
          `DELETE FROM ${ownerTables.alarms} WHERE owner=$1 AND name=$2`,
          [ownerId, deliveryAlarm(row.namespace, id)],
        );
        await settlement.schedule(context, {
          namespace: row.namespace,
          operationId: row.settlement_scope_id,
        });
        return { status: row.status };
      },
    },
    projections: {
      ...execution.projections,
      ...effects.projections,
      ...settlement.projections,
      [result.kind]: result.handler,
      "action.prepare": async (_input, context) => {
        const prepared = preparedScopes.get(context.tx);
        preparedScopes.delete(context.tx);
        if (!prepared) unavailable();
        const { scope, request } = prepared;
        const requestId = await deriveWorkflowId(
          "root-call",
          ownerId,
          scope.namespace,
          scope.principalKey,
          scope.route.kind,
          scope.route.id,
          registry.actions[request.actionAlias].id,
          request.operationKey ?? crypto.randomUUID(),
        );
        return {
          kind: OWNER_ACTION_ADMISSION,
          domain: "logical",
          key: ownerActionAdmissionKey(ownerId, scope.namespace, requestId),
          input: {
            namespace: scope.namespace,
            actionAlias: request.actionAlias,
            requestId,
            input: request.input,
            metadata: scope.actionMetadata,
            provenance: provenance(scope),
          },
        };
      },
      "host.initialize": async (_input, context) => {
        await validateCopilotzSchema(context.tx, schema);
        await validateOperationCatalog({
          query: context.tx.query.bind(context.tx),
          transaction() {
            throw new Error("Nested validation transactions are forbidden.");
          },
        }, schema);
        await validateOwnerCommandSchema(context.tx, schema, ownerId);
        await validateOwnerAssignments(context.tx, schema);
        if (owner.epoch !== 1) {
          unavailable(
            "Fresh host cannot take over an existing epoch.",
          );
        }
        for (
          const table of [
            tables.nodes,
            tables.edges,
            tables.events,
            tables.event_deliveries,
            tables.open_actions,
            operationTables.operations,
            operationTables.operationStreams,
            assignmentTable,
            ownerTables.receipts,
            ownerTables.alarms,
          ]
        ) {
          if (
            (await context.tx.query(`SELECT 1 FROM ${table} LIMIT 1`)).rows
              .length
          ) {
            unavailable(
              "Fresh owner host requires empty tables; restart reconciliation is not implemented.",
            );
          }
        }
        return null;
      },
      "host.alarms": async (_input, context) => {
        const rows = await context.tx.query<{ name: string }>(
          `SELECT name FROM ${ownerTables.alarms} WHERE owner=$1 AND due_at <= $2::timestamptz ORDER BY due_at,name LIMIT $3`,
          [ownerId, context.commandTime, maxPending * 2 + 1],
        );
        if (rows.rows.length > maxPending * 2) {
          unavailable("Owner alarm capacity exceeded.");
        }
        const found: OwnerJson[] = [];
        for (const row of rows.rows) {
          const name = JSON.parse(row.name);
          if (!Array.isArray(name) || name.length !== 3) {
            unavailable("Unsupported owner alarm.");
          }
          const [kind, namespace, id] = name;
          text(namespace);
          text(id);
          if (kind === OWNER_OPERATION_SETTLEMENT) {
            found.push({ kind: "settlement", namespace, operationId: id });
          } else if (kind === "host.delivery") {
            const delivery = (await context.tx.query<
              {
                id: string;
                event_id: string;
                status: string;
                attempts: number;
                metadata: Record<string, OwnerJson>;
              }
            >(
              `SELECT d.id,d.event_id,d.status,d.attempts,e.metadata FROM ${tables.event_deliveries} d JOIN ${tables.events} e ON e.id=d.event_id WHERE d.id=$1 AND e.namespace=$2 AND e.owner_id=$3 AND e.type='copilotz.owner.action.requested'`,
              [id, namespace, ownerId],
            )).rows[0];
            if (!delivery) {
              unavailable("Owner alarm has no matching durable delivery.");
            }
            found.push({
              kind: "delivery",
              namespace,
              deliveryId: id,
              eventId: delivery.event_id,
              actionId: delivery.metadata.actionId,
              executionId: delivery.metadata.actionRunId,
              status: delivery.status,
              attempts: delivery.attempts,
            });
          } else unavailable("Owner alarm requires an unsupported capability.");
        }
        return found;
      },
      "host.assignment-grants": async (input, context) => {
        const assignment = await resolveExecution(
          context.tx,
          input as OwnerCaller,
          context.commandTime,
        );
        return assignment
          ? {
            ctx: assignment.ctxGranted,
            settlement: assignment.settlementGranted,
          }
          : null;
      },
      "host.readiness": async (input, context) => {
        const fence = input as unknown as Fence;
        const grants = await policy.worker(
          context.tx,
          copy({ fence }),
          context.commandTime,
        );
        return !!grants && current(fence);
      },
    },
    inputDefinitions: {
      ...execution.inputDefinitions,
      [OWNER_ACTION_ADMISSION]: admission.inputDefinition,
    },
    async authorize(tx, caller, command, time, normalized) {
      if (command.kind.startsWith("host.")) {
        assertControl(caller);
        return;
      }
      if (!ready()) unavailable();
      if (command.kind.startsWith("assignment.")) {
        await bridge.authorizeAssignment(tx, caller, command, time);
        if (command.kind === "assignment.bind") {
          // Only the bridge's already-validated private control witness can get
          // here. New dispatch needs current ctx authority, even if this same
          // worker remains eligible for old settlement and receipt reads.
          const binding = copy(command.intent) as OwnerAssignmentBinding;
          if ("kind" in binding) unavailable();
          const sessionView = transport!.sessions.get(binding.workerId);
          if (
            !sessionView || sessionView.connectionId !== binding.sessionId ||
            sessionView.sessionGeneration !== binding.sessionGeneration ||
            sessionView.identity.attemptId !== binding.workerAttemptId
          ) unavailable();
          const fence: Fence = {
            identity: { ...sessionView.identity },
            connectionId: binding.sessionId,
            sessionGeneration: binding.sessionGeneration,
          };
          if (!current(fence)) unavailable();
          const returned = await policy.worker(
            tx,
            copy({ fence, assignment: binding }),
            time,
          );
          const grants = returned && copy(returned);
          if (grants?.ctx !== true || !current(fence)) {
            unavailable("Current worker policy refuses new execution.");
          }
        }
        return;
      }
      if (command.kind === "action.prepare") {
        const request = copy(
          command.intent,
        ) as unknown as OwnerActionCallRequest;
        if (
          !request || typeof request !== "object" || Array.isArray(request) ||
          Object.keys(request).some((key) =>
            !["actionAlias", "input", "operationKey"].includes(key)
          ) || !Object.hasOwn(request, "input")
        ) unavailable();
        text(request.actionAlias);
        if (request.operationKey !== undefined) text(request.operationKey);
        const scope = await scopeFor(tx, caller, time);
        if (!scope.allowedActions.includes(request.actionAlias)) unavailable();
        preparedScopes.set(tx, { scope, request });
        return;
      }
      if (command.kind === OWNER_ACTION_ADMISSION) {
        validateOwnerActionAdmissionIdentity(ownerId, command, normalized);
        const scope = await scopeFor(tx, caller, time);
        await assertIngress(tx, scope, normalized);
        if (
          !scope.allowedActions.includes(normalized.actionAlias)
        ) unavailable();
        admissionScopes.set(tx, scope);
        return;
      }
      if (command.kind === result.kind) {
        return await result.authorize(tx, caller, command, time);
      }
      if (
        command.kind === OWNER_OPERATION_SETTLEMENT ||
        command.kind === OWNER_OPERATION_READINESS
      ) {
        return await settlement.authorize(tx, caller, command, time);
      }
      if (command.kind.startsWith("effect.")) {
        return await effects.authorize(tx, caller, command, time);
      }
      if (command.kind === "collections") {
        const assignment = await execution.authorizeLive(tx, caller, time);
        if (
          command.domain !== "logical" ||
          !command.key.startsWith(`${assignment.invocation.operationKey}/`)
        ) {
          unavailable();
        }
        const conditions = copy(
          await policy.collections(
            tx,
            copy(assignment),
            copy(command.intent) as unknown as OwnerCollectionIntent,
            time,
          ),
        );
        collectionScopes.set(tx, {
          namespace: assignment.namespace,
          identity: copy(assignment.invocation.identity),
          conditions: conditions.conditions,
        });
        return;
      }
      return await execution.authorize(tx, caller, command, time, normalized);
    },
    authenticateReceipt(_tx, caller) {
      if (
        ![...receiptCalls].some((context) =>
          context.fence.identity.workerId === caller.workerId &&
          current(context.fence) && !context.signal.aborted
        )
      ) unavailable();
    },
    onPostCommitError: report,
  });
  function pump() {
    if (pumping || !ready() || !transport) return;
    pumping = true;
    try {
      for (const [key, ref] of pending) {
        if (active.size >= maxActive) break;
        if (active.has(key)) continue;
        const task = (async () => {
          let dispatched = false;
          try {
            const handle = await bridge.dispatch(transport!, {
              workload: OWNER_ACTION_WORKLOAD,
              body: new Uint8Array(),
              signal: abort.signal,
              deadlineAtMs: Date.now() + 10_000,
            }, key);
            dispatched = true;
            // Consume protocol output, but never interpret it as durable success.
            const drain = (async () => {
              const reader = handle.output.getReader();
              try {
                while (
                  !(await reader.read()).done
                ) { /* bounded protocol flow control */ }
              } finally {
                reader.releaseLock();
              }
            })();
            await Promise.all([handle.completed, drain]);
            await control((caller) =>
              owner.execute(caller, {
                kind: "host.delivery-finished",
                domain: "occurrence",
                key: crypto.randomUUID(),
                intent: { deliveryId: ref.deliveryId },
              })
            );
            pending.delete(key);
          } catch (error) {
            if (dispatched) stop(error);
            else report(error);
          } finally {
            active.delete(key);
          }
        })();
        active.set(key, task);
        void task.finally(() => {
          if (ready() && !pending.has(key)) queueMicrotask(pump);
        });
      }
    } finally {
      pumping = false;
    }
  }
  function pumpSettlements(): Promise<void> {
    if (settlementPump) return settlementPump;
    settlementPump = (async () => {
      for (const [key, target] of [...settlements]) {
        if (!ready()) return;
        settlements.delete(key);
        try {
          await control((caller) =>
            settlement.run({
              boundary: owner,
              caller,
              target,
              occurrence: crypto.randomUUID(),
              signal: abort.signal,
            })
          );
        } catch (error) {
          // A fresh-only host cannot resolve an ambiguous submitted settlement
          // by inventing a new occurrence. Preserve its alarm and fail closed.
          if (uncertain(error)) stop(error);
          else report(error);
        }
      }
    })().finally(() => {
      settlementPump = undefined;
      if (ready() && settlements.size) {
        queueMicrotask(() => {
          void pumpSettlements();
        });
      }
    });
    return settlementPump;
  }
  /** Bounded discovery during this live fresh epoch. It never reclaims a lost
   * attempt or consumes an alarm based on a transport result. */
  function wakeAlarms(): Promise<void> {
    if (alarmPass) return alarmPass;
    if (!ready()) return Promise.resolve();
    alarmPass = (async () => {
      await bridge.retryRetirements();
      const alarms = await control((caller) =>
        owner.project(caller, "host.alarms", null)
      ) as readonly Record<string, OwnerJson>[];
      for (const alarm of alarms) {
        if (!ready()) return;
        if (alarm.kind === "settlement") {
          wake({
            namespace: String(alarm.namespace),
            operationId: String(alarm.operationId),
          });
        } else {
          const id = String(alarm.deliveryId);
          if (active.has(id)) continue;
          if (
            ["succeeded", "dead_letter", "cancelled"].includes(
              String(alarm.status),
            )
          ) {
            await control((caller) =>
              owner.execute(caller, {
                kind: "host.delivery-finished",
                domain: "occurrence",
                key: crypto.randomUUID(),
                intent: { deliveryId: id },
              })
            );
            pending.delete(id);
          } else if (alarm.status === "pending" && alarm.attempts === 0) {
            enqueue({
              namespace: alarm.namespace,
              actionId: alarm.actionId,
              executionId: alarm.executionId,
              eventId: alarm.eventId,
              deliveryId: alarm.deliveryId,
            });
          } else {
            stop(
              new Error(
                "Lost/retried delivery requires concrete recovery integration.",
              ),
            );
            return;
          }
        }
      }
      pump();
    })().finally(() => {
      alarmPass = undefined;
    });
    return alarmPass;
  }
  function armAlarm() {
    if (!ready()) return;
    clearTimeout(alarmTimer);
    alarmTimer = setTimeout(() => {
      void wakeAlarms().catch(report).finally(armAlarm);
    }, 1000);
  }
  const calls = createOwnerWorkerCallAdmission({
    resolveOwner: (id) => id === ownerId && ready() ? owner : undefined,
    async authorizeReadiness(context, id) {
      return id === ownerId && current(context.fence) &&
        await control((caller) =>
            owner.project(
              caller,
              "host.readiness",
              copy(context.fence) as unknown as OwnerJson,
            )
          ) === true;
    },
    resolveIngress(context, id, route) {
      if (id !== ownerId || !current(context.fence) || context.signal.aborted) {
        return undefined;
      }
      let witness = ingressContexts.get(context);
      if (!witness) {
        if (ingressTokens.size >= maxPending) return undefined;
        witness = {
          token: crypto.randomUUID(),
          context,
          fence: copy(context.fence),
          route,
        };
        ingressContexts.set(context, witness);
        ingressTokens.set(witness.token, witness);
      }
      if (witness.route !== route) return undefined;
      return {
        workerId: witness.fence.identity.workerId,
        ownerEpoch: owner.epoch!,
        hostIngress: witness.token,
      };
    },
    async prepareIngressAction(context, id, caller, request, signal) {
      if (id !== ownerId || !current(context.fence)) unavailable();
      return await owner.project(
        caller,
        "action.prepare",
        copy(request) as OwnerJson,
        { signal },
      ) as OwnerInputCommand;
    },
    async resolveAssignment(context, id) {
      const found = bridge.resolveAssignment(context, id);
      if (!found || !ready()) return undefined;
      // Grant lookup is re-run with the exact started witness under the fence.
      const grants = await control((caller) =>
        owner.project(
          caller,
          "host.assignment-grants",
          copy(found.caller) as OwnerJson,
        )
      ) as { ctx: boolean; settlement: boolean } | null;
      if (!grants) return undefined;
      return {
        ...found,
        ctxGranted: grants.ctx === true,
        settlementGranted: grants.settlement === true,
      };
    },
  });
  const wrapped = bridge.wrapWorkerCalls(calls);
  // Revocation and capacity are separate: cancelled unstarted calls release
  // promptly, while running/admitting noncooperative work retains its slot.
  const reverseCalls = new Set<object>();
  function trackAdmission(
    admit: Admissions["admit"] | NonNullable<Admissions["admitUnassigned"]>,
  ): Admissions["admit"] {
    return async (context) => {
      if (
        !current(context.fence) || context.signal.aborted ||
        reverseCalls.size >= maxPending
      ) return undefined;
      const entry = {};
      reverseCalls.add(entry);
      let phase: "admitting" | "admitted" | "running" | "released" =
        "admitting";
      const signal = AbortSignal.any([context.signal, abort.signal]);
      const revoke = () => {
        receiptCalls.delete(context);
        const witness = ingressContexts.get(context);
        if (witness) {
          ingressTokens.delete(witness.token);
          ingressContexts.delete(context);
        }
      };
      const release = () => {
        if (phase === "released") return;
        phase = "released";
        revoke();
        reverseCalls.delete(entry);
        signal.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        revoke();
        if (phase === "admitted") release();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      receiptCalls.add(context);
      try {
        const handler = await admit(context);
        if (!handler || signal.aborted) {
          release();
          return undefined;
        }
        phase = "admitted";
        return async (input) => {
          if (phase !== "admitted" || signal.aborted) unavailable();
          phase = "running";
          try {
            return await handler(input);
          } finally {
            release();
          }
        };
      } catch (error) {
        release();
        throw error;
      }
    };
  }
  const workerCalls: Admissions = {
    admit: trackAdmission(wrapped.admit),
    admitUnassigned: trackAdmission(wrapped.admitUnassigned!),
  };

  try {
    await owner.acquire(0);
    await control((caller) => owner.project(caller, "host.initialize", null));
    transport = options.createTransport({
      ...options.transport,
      workerCalls: {
        ...workerCalls,
        maxConcurrent: maxPending,
        maxPerConnection: maxActive + 2,
        timeoutMs: 30_000,
      },
    }, {
      ...bridge.lifecycle,
      onReady() {
        queueMicrotask(pump);
      },
    });
    initialized = true;
    armAlarm();
  } catch (error) {
    stop(error);
    await transport?.shutdown("owner initialization failed");
    throw error;
  }
  return {
    prepare: transport.prepare.bind(transport),
    listener: {
      prepare: transport.prepare.bind(transport),
      snapshot: transport.snapshot.bind(transport),
    },
    wake: wakeAlarms,
    snapshot: () => ({
      ready: ready(),
      state: closed ? "closed" : owner.state,
      epoch: owner.epoch,
      pending: pending.size,
      active: active.size,
      settlementChecks: settlements.size,
      assignments: bridge.snapshot(),
      recoveryRequired: fault !== undefined ||
        (!closed && owner.state === "stopped"),
    }),
    async close(reason = "owner host closed") {
      if (closed) return;
      closed = true;
      initialized = false;
      clearTimeout(alarmTimer);
      abort.abort(new Error(reason));
      bridge.stop();
      await transport!.shutdown(reason);
      await Promise.allSettled([...active.values()]);
      await settlementPump;
      await alarmPass?.catch(() => undefined);
      await bridge.retryRetirements();
      owner.stop(reason);
    },
  };
}
