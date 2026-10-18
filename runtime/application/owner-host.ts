import {
  createOwnerSnapshotResources,
  type OwnerHistoricalReadPolicy,
} from "../owner/snapshot.ts";
import type { OwnerAuthorityReadMode } from "../owner/authority-read.ts";
/** Private ordinary Action/Processor host. Every worker, including embedded
 * workers, uses the same Oxian transport. A private fresh-owner bundle selects
 * local Actions and same-owner Processor generations without public activation.
 * Resume requires bounded compatible
 * event history and, when declared, ordinary Collection namespace coverage.
 * Closed ordinary-record prepared children of root ordinary Actions require
 * matching preparation registration. Lost/retried or open prepared work,
 * prepared ancestry, content, streams and protected/deferred history stay blocked. */
import type {
  Hypervisor,
  HypervisorOptions,
} from "../../dependencies/oxian-hypervisor.ts";
import {
  createOwnerCollectionRead,
  type OwnerCollectionReadPolicy,
} from "../owner/collection-read.ts";
import { OWNER_COLLECTION_READ } from "../execution/collection-read-call.ts";
import { defineCollection } from "../collections/definition.ts";
import {
  provisionCollectionIndexes,
  validateCollectionIndexes,
} from "../collections/indexes.ts";
import { actionDefinitionHasSecrets } from "../actions/secret.ts";
import {
  createCoreTableNames,
  provisionCopilotzSchema,
  quoteEventIdentifier,
  validateCopilotzSchema,
} from "../events/schema.ts";
import { deriveWorkflowId } from "../events/workflow-id.ts";
import type { SqlExecutor, SqlSession } from "../events/session.ts";
import type { DurableEvent } from "../events/types.ts";
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
  type OwnerCommandBoundary,
  type OwnerCommandContext,
  type OwnerCommandHandler,
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
import {
  createOwnerChildActions,
  OWNER_CHILD_ACTION_ADMISSION,
  OWNER_CHILD_ACTION_RESULT,
  type OwnerChildActionBinding,
  type OwnerChildActionParent,
} from "../owner/child-action.ts";
import {
  createOwnerProcessorCommands,
  type OwnerProcessorAssignment,
} from "../owner/processor.ts";
import type {
  OwnerEffectEvidence,
  OwnerEffectReference,
} from "../owner/effects-client.ts";
import {
  createOwnerExecutionCommands,
  type OwnerExecutionAssignment,
  type OwnerWorkerExecutionAssignment,
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
  createOwnerStartupProof,
  OWNER_STARTUP_PROOF,
  OWNER_STARTUP_REPAIR,
  ownerStartupRepairKey,
} from "../owner/startup.ts";
import {
  createOwnerPreparations,
  OWNER_CHILD_ACTION_PREPARATION,
  type OwnerPreparationRegistration,
  type OwnerPreparedInputContext,
} from "../owner/preparation.ts";
import {
  createOwnerPreparationRecordSource,
  type OwnerPreparationRecordSourceOptions,
} from "../owner/preparation-record-source.ts";
import type { OwnerPreparedHistoryRegistration } from "../owner/startup-prepared.ts";
import type { OwnerPreparationResourcesOptions } from "../owner/preparation-resources.ts";
import { ownerPrincipalIdentity } from "../owner/principal.ts";
import {
  createOwnerDispatchBridge,
  type OwnerDispatchAdmissions,
  type OwnerDispatchLifecycle,
  type OwnerScheduledAssignment,
} from "./owner-dispatch.ts";
import {
  OWNER_ACTION_WORKLOAD,
  OWNER_PROCESSOR_WORKLOAD,
} from "./owner-worker.ts";

import {
  captureOwnerHostLocalActions,
  createOwnerHostCommandContexts,
  createOwnerHostLocalActions,
  type OwnerHostLocalActionOptions,
} from "./owner-host-local.ts";

import {
  captureOwnerHostLocalProcessors,
  createOwnerHostLocalProcessors,
  type OwnerHostLocalProcessorOptions,
} from "./owner-host-local-processor.ts";
import { ownConfiguration } from "./owner-local-configuration.ts";

export type OwnerHostLocalOptions = Readonly<{
  actions?: OwnerHostLocalActionOptions;
  processors?: OwnerHostLocalProcessorOptions;
}>;

import {
  captureOwnerHostTerminalRecovery,
  createOwnerHostTerminalRecovery,
  type OwnerHostTerminalRecoveryOptions,
  type OwnerHostTerminalRecoveryTarget,
} from "./owner-host-terminal-recovery.ts";
import { OWNER_LOST_ACTION_RECOVERY } from "../owner/lost-action.ts";

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
  /** Explicit whole-record/aggregate read grant. Row constraints apply before SQL
   * pagination; absence denies across worker and private local placements. */
  collectionRead?: OwnerCollectionReadPolicy;
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
    assignment: OwnerWorkerExecutionAssignment,
    value: OwnerJson,
    time: string,
  ): void | Promise<void>;
  collections(
    tx: SqlExecutor,
    assignment: OwnerWorkerExecutionAssignment | OwnerProcessorAssignment,
    intent: OwnerCollectionIntent,
    time: string,
  ):
    | Pick<OwnerCollectionScope, "conditions">
    | Promise<Pick<OwnerCollectionScope, "conditions">>;
  /** Required when Processors are registered; rerun on input and ctx mutations. */
  processorEvent?(
    tx: SqlExecutor,
    assignment: OwnerProcessorAssignment,
    event: DurableEvent,
    data: OwnerJson,
    time: string,
  ): void | Promise<void>;
  /** Operation-specific nested authority, distinct from public Action exposure.
   * An absent callback explicitly refuses child admission and result access. */
  child?(
    tx: SqlExecutor,
    parent: OwnerChildActionParent,
    actionId: string,
    time: string,
  ): void | Promise<void>;
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
type Admissions = OwnerDispatchAdmissions;
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
/** Owner-only ordinary-record preparation configuration. Registered callbacks
 * remain in this host; workers send only the fixed named request. Original
 * projection/resource permission is required on capture and every reuse.
 * Prepared retained histories remain outside the startup proof's subset. */
export type OwnerHostPreparationOptions = Readonly<{
  records: Omit<
    OwnerPreparationRecordSourceOptions,
    "ownerId" | "schema" | "registry"
  >;
  registrations: Readonly<Record<string, OwnerPreparationRegistration>>;
  projectResource: OwnerPreparationResourcesOptions["projectResource"];
  authorizeResource: OwnerPreparationResourcesOptions["authorizeResource"];
  maxPendingRenders?: number;
  renderTimeoutMs?: number;
  maxBytes?: number;
}>;
export type OwnerHostOptions = Readonly<{
  ownerId: string;
  holderId: string;
  schema: string;
  session: SqlSession;
  initialization:
    | "fresh"
    | Readonly<{
      mode: "resume";
      /** CAS expectation for the PRIOR durable epoch, not the acquired successor. */
      expectedEpoch: number;
      maxItems?: number;
      maxBytes?: number;
      maxPasses?: number;
    }>;
  registry: PluginRegistry;
  policy: OwnerHostPolicy;
  preparation?: OwnerHostPreparationOptions;
  /** Private opt-in selection scopes; load evidence must choose production limits. */
  snapshots?: Readonly<{
    authorizeHistorical: OwnerHistoricalReadPolicy;
    idleTimeoutMs: number;
    maxLifetimeMs: number;
    maxPendingReads: number;
  }>;
  transport: Omit<HypervisorOptions, "workerCalls">;
  createTransport(
    options: OwnerHostTransportOptions,
    lifecycle: OwnerDispatchLifecycle & Readonly<{ onReady(): void }>,
  ): Hypervisor;
  maxPending?: number;
  maxActive?: number;
  /** Bounds transport admission only; opened work is current-session/attempt controlled. */
  dispatchWaitMs?: number;
  now?: () => string;
  onError?(error: unknown): void;
}>;
/** Narrow a verified execution assignment for worker-only policy callbacks. */
function workerAssignment(
  value: OwnerExecutionAssignment,
): OwnerWorkerExecutionAssignment {
  if (value.placement !== "worker") {
    unavailable("Local placement is unavailable in this host.");
  }
  return value;
}
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
export async function createOwnerHost(
  options: OwnerHostOptions,
  namespaceInventory?: readonly string[],
  localOptions?: OwnerHostLocalOptions,
  terminalRecovery?: OwnerHostTerminalRecoveryOptions,
) {
  for (const value of [options.ownerId, options.holderId, options.schema]) {
    text(value);
  }
  const initialization = options.initialization === "fresh"
    ? "fresh"
    : copy(options.initialization);
  if (initialization !== "fresh") {
    if (
      !initialization || typeof initialization !== "object" ||
      Array.isArray(initialization) || initialization.mode !== "resume" ||
      Object.keys(initialization).some((key) =>
        !["mode", "expectedEpoch", "maxItems", "maxBytes", "maxPasses"]
          .includes(key)
      ) ||
      (["maxItems", "maxBytes", "maxPasses"] as const).some((key) =>
        Object.hasOwn(initialization, key) &&
        typeof initialization[key] !== "number"
      ) ||
      !Number.isSafeInteger(initialization.expectedEpoch) ||
      initialization.expectedEpoch < 1 ||
      initialization.expectedEpoch >= Number.MAX_SAFE_INTEGER ||
      !Number.isSafeInteger(initialization.maxItems ?? 1000) ||
      (initialization.maxItems ?? 1000) < 1 ||
      (initialization.maxItems ?? 1000) > 10_000 ||
      !Number.isSafeInteger(initialization.maxBytes ?? 8 * 1024 * 1024) ||
      (initialization.maxBytes ?? 8 * 1024 * 1024) < 1024 ||
      (initialization.maxBytes ?? 8 * 1024 * 1024) > 32 * 1024 * 1024 ||
      !Number.isSafeInteger(initialization.maxPasses ?? 4) ||
      (initialization.maxPasses ?? 4) < 1 ||
      (initialization.maxPasses ?? 4) > 16
    ) throw new TypeError("Invalid owner host resume options.");
  }
  if (localOptions !== undefined && initialization !== "fresh") {
    throw new TypeError(
      "Private local placement requires fresh initialization; local resume is unavailable.",
    );
  }
  if (
    terminalRecovery !== undefined &&
    (initialization === "fresh" || localOptions !== undefined)
  ) {
    throw new TypeError(
      "Private terminal recovery requires resume without local placement.",
    );
  }
  const snapshotConfiguration = options.snapshots === undefined
    ? undefined
    : ownConfiguration(options.snapshots, [
      "authorizeHistorical",
      "idleTimeoutMs",
      "maxLifetimeMs",
      "maxPendingReads",
    ]);
  if (
    snapshotConfiguration &&
    (typeof snapshotConfiguration.authorizeHistorical !== "function" ||
      [
        snapshotConfiguration.idleTimeoutMs,
        snapshotConfiguration.maxLifetimeMs,
        snapshotConfiguration.maxPendingReads,
      ]
        .some((value) =>
          typeof value !== "number" || !Number.isSafeInteger(value) ||
          value < 1 || value > 2_147_483_647
        ))
  ) {
    throw new TypeError("Invalid private snapshot configuration.");
  }
  const terminalConfiguration = terminalRecovery === undefined
    ? undefined
    : captureOwnerHostTerminalRecovery(terminalRecovery);
  const localBundle = localOptions === undefined
    ? undefined
    : ownConfiguration(localOptions, [], ["actions", "processors"]);
  if (localBundle && !Object.keys(localBundle).length) {
    throw new TypeError("At least one private local selection is required.");
  }
  const localConfiguration =
    localBundle && Object.hasOwn(localBundle, "actions")
      ? captureOwnerHostLocalActions(
        localBundle.actions as OwnerHostLocalActionOptions,
        options.registry,
      )
      : undefined;
  const processorConfiguration =
    localBundle && Object.hasOwn(localBundle, "processors")
      ? captureOwnerHostLocalProcessors(
        localBundle.processors as OwnerHostLocalProcessorOptions,
        options.registry,
      )
      : undefined;
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
  if (
    Object.keys(options.registry.processors).length &&
    typeof options.policy.processorEvent !== "function"
  ) {
    throw new TypeError("Current Processor event policy is required.");
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
  const preparation = options.preparation;
  if (Object.hasOwn(options, "preparation")) {
    if (
      !preparation || typeof preparation !== "object" ||
      Array.isArray(preparation) ||
      Object.keys(preparation).some((key) =>
        ![
          "records",
          "registrations",
          "projectResource",
          "authorizeResource",
          "maxPendingRenders",
          "renderTimeoutMs",
          "maxBytes",
        ].includes(key)
      ) ||
      !preparation.records || typeof preparation.records !== "object" ||
      Array.isArray(preparation.records) ||
      Object.keys(preparation.records).some((key) =>
        ![
          "sources",
          "authorize",
          "projectRecord",
          "authorizeReference",
          "maxBytes",
        ].includes(key)
      ) ||
      !preparation.registrations ||
      typeof preparation.registrations !== "object" ||
      Array.isArray(preparation.registrations) ||
      typeof preparation.projectResource !== "function" ||
      typeof preparation.authorizeResource !== "function"
    ) throw new TypeError("Invalid owner preparation options.");
    for (
      const key of ["maxPendingRenders", "renderTimeoutMs", "maxBytes"] as const
    ) {
      if (
        Object.hasOwn(preparation, key) && typeof preparation[key] !== "number"
      ) {
        throw new TypeError("Invalid owner preparation budget.");
      }
    }
    if (
      Object.hasOwn(preparation.records, "maxBytes") &&
      typeof preparation.records.maxBytes !== "number"
    ) {
      throw new TypeError("Invalid owner preparation record budget.");
    }
  }
  const maxPending = limit(options.maxPending ?? 128);
  const maxActive = limit(options.maxActive ?? 16);
  const dispatchWaitMs = limit(options.dispatchWaitMs ?? 10_000);
  if (maxActive > maxPending) {
    throw new TypeError("Active capacity exceeds pending capacity.");
  }
  const {
    session,
    schema,
    ownerId,
    holderId,
    registry,
    createTransport,
    now,
    onError,
  } = options;
  const policy = { ...options.policy };
  const transportOptions = { ...options.transport };
  // Only declarative fields used by the index planner cross initialization awaits.
  const collectionDefinitions = Object.values(
    registry.collections,
  ).map((definition) =>
    defineCollection(copy({
      name: definition.name,
      schema: definition.schema,
      ...(definition.indexes ? { indexes: definition.indexes } : {}),
    }))
  );
  const tables = createCoreTableNames(schema);
  const ownerTables = ownerTableNames(schema);
  const operationTables = createOperationCatalogTables(schema);
  const assignmentTable = `${quoteEventIdentifier(schema)}."owner_assignments"`;
  const catalog = createOperationCatalog(session, schema);
  const abort = new AbortController();
  let notifyStopped!: () => void;
  const stopped = new Promise<void>((resolve) => notifyStopped = resolve);
  let transport: Hypervisor | undefined;
  let initialized = false;
  let closed = false;
  let closing: Promise<void> | undefined;
  let fault: unknown;
  const pending = new Map<string, OwnerScheduledAssignment>();
  const placements = new Map<string, "worker" | "owner-local">();
  const active = new Map<
    string,
    Readonly<{ placement: "worker" | "owner-local"; token: object }>
  >();
  const runningTasks = new Set<Promise<void>>();
  let local: ReturnType<typeof createOwnerHostLocalActions> | undefined;
  let localProcessor:
    | ReturnType<typeof createOwnerHostLocalProcessors>
    | undefined;
  let localControlToken: string | undefined;
  let snapshots: ReturnType<typeof createOwnerSnapshotResources> | undefined;
  const settlements = new Map<string, OperationSettlementScope>();
  let pumping = false;
  let settlementPump: Promise<void> | undefined;
  let alarmTimer: ReturnType<typeof setTimeout> | undefined;
  let alarmPass: Promise<void> | undefined;
  type ControlPurpose =
    | "runtime"
    | "local-start"
    | "fresh"
    | "schema"
    | "startup"
    | "startup-settlement";
  const controlTokens = new Map<
    string,
    { purpose: ControlPurpose; target?: OperationSettlementScope }
  >();
  const freshKey = JSON.stringify([
    "host.initialize-fresh",
    ownerId,
    holderId,
    crypto.randomUUID(),
  ]);
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
      onError?.(error);
    } catch { /* diagnostics cannot change durability */ }
  }
  function stop(error?: unknown) {
    if (abort.signal.aborted) return;
    fault ??= error;
    initialized = false;
    clearTimeout(alarmTimer);
    local?.stop(error);
    localProcessor?.stop(error);
    void snapshots?.stop().catch(report);
    if (localControlToken) controlTokens.delete(localControlToken);
    owner?.stop(error);
    abort.abort(error);
    bridge.stop();
    notifyStopped();
    report(error);
  }
  function ready() {
    return initialized && !closed && owner.state === "acquired" &&
      !abort.signal.aborted;
  }
  const commandContexts = createOwnerHostCommandContexts({
    ownerId,
    holderId,
    epoch: () => owner.epoch,
    isCurrent: ready,
  });
  function reserveActive(key: string, placement: "worker" | "owner-local") {
    if (
      !ready() || active.has(key) || active.size >= maxActive ||
      !pending.has(key) || placements.get(key) !== placement
    ) return undefined;
    const entry = { placement, token: {} };
    active.set(key, entry);
    let released = false;
    return {
      release() {
        if (released || active.get(key) !== entry) {
          unavailable("Execution capacity release is not current.");
        }
        released = true;
        active.delete(key);
        if (placement === "owner-local") {
          pending.delete(key);
          placements.delete(key);
        }
        if (ready() && !pending.has(key)) queueMicrotask(pump);
      },
    };
  }
  function trackTask(task: Promise<void>) {
    runningTasks.add(task);
    void task.finally(() => runningTasks.delete(task));
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
    purpose: ControlPurpose = "runtime",
    target?: OperationSettlementScope,
  ): Promise<T> {
    const token = crypto.randomUUID();
    controlTokens.set(token, {
      purpose,
      ...(target ? { target: copy(target) } : {}),
    });
    try {
      return await run({
        principal: {
          kind: "owner-control",
          ownerId,
          epoch: owner.epoch!,
          holderId,
        },
        ownerEpoch: owner.epoch!,
        hostControl: token,
      });
    } finally {
      controlTokens.delete(token);
    }
  }
  function assertControl(
    caller: OwnerCaller,
    purpose: ControlPurpose = "runtime",
  ) {
    if (
      caller.principal.kind !== "owner-control" ||
      caller.principal.ownerId !== ownerId ||
      caller.principal.holderId !== holderId ||
      caller.principal.epoch !== owner.epoch ||
      caller.ownerEpoch !== owner.epoch ||
      typeof caller.hostControl !== "string" ||
      controlTokens.get(caller.hostControl)?.purpose !== purpose
    ) unavailable();
  }
  const bridge = createOwnerDispatchBridge({
    ownerId,
    schema,
    maxAssignments: maxActive,
    maxWitnesses: maxPending,
    hasProcessor: (id) =>
      registry.processorForConsumer(`processor:${id}`)?.id === id,
    getOwnerAuthority: () => closed ? undefined : { boundary: owner, holderId },
    sessions: {
      assertCurrent: (fence) => {
        if (!transport) unavailable();
        return transport.sessions.assertCurrent(fence);
      },
    },
    resolveScheduled: (key) => {
      const value = pending.get(key);
      return value && placements.get(key) === "worker"
        ? copy(value)
        : undefined;
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
      !witness || caller.principal.kind !== "worker" ||
      caller.principal.workerId !== witness.fence.identity.workerId ||
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
  async function resolveCurrentAssignment(
    tx: SqlExecutor,
    caller: OwnerCaller,
    time: string,
    readMode: OwnerAuthorityReadMode = "locking",
  ) {
    const binding = await bridge.resolveStarted(tx, caller, readMode);
    if (!binding || !ready()) {
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
    if (!grants || !await bridge.resolveStarted(tx, caller, readMode)) {
      return undefined;
    }
    return { binding: copy(binding), grants };
  }
  async function resolveExecution(
    tx: SqlExecutor,
    caller: OwnerCaller,
    time: string,
    readMode: OwnerAuthorityReadMode = "locking",
  ): Promise<OwnerExecutionAssignment | undefined> {
    if (caller.principal.kind === "owner-local") {
      return await local?.resolve(tx, caller, time, readMode);
    }
    const current = await resolveCurrentAssignment(tx, caller, time, readMode);
    if (!current || "kind" in current.binding) return undefined;
    const { binding, grants } = current;
    const source = (await tx.query<
      {
        metadata: Record<string, OwnerJson>;
        namespace: string;
        id: string;
        correlation_id: string;
        settlement_scope_id: string;
        action_scope_id: string | null;
      }
    >(
      `SELECT e.id,e.namespace,e.metadata,e.correlation_id,d.settlement_scope_id,d.action_scope_id FROM ${tables.events} e JOIN ${tables.event_deliveries} d ON d.event_id=e.id WHERE e.id=$1 AND e.owner_id=$2 AND d.id=$3`,
      [binding.sourceEventId, ownerId, binding.deliveryId],
    )).rows[0];
    if (
      !source || source.namespace !== binding.namespace ||
      source.metadata.actionId !== binding.actionId ||
      source.metadata.actionRunId !== binding.executionId
    ) unavailable();
    const metadata = copy(source.metadata.actionMetadata) as JsonObject;
    const rootKey = source.metadata.rootKey ?? binding.executionId;
    text(rootKey);
    const parentActionRunId = source.metadata.parentActionRunId;
    if (parentActionRunId !== undefined) text(parentActionRunId);
    return {
      placement: "worker",
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
        rootKey,
        operationKey: binding.executionId,
        ...(parentActionRunId ? { parentActionRunId } : {}),
        metadata,
        identity: {
          causationId: source.id,
          correlationId: source.correlation_id,
          settlementScopeId: source.settlement_scope_id,
          ...(source.action_scope_id
            ? { actionScopeId: source.action_scope_id }
            : {}),
        },
      },
    };
  }
  async function resolveProcessor(
    tx: SqlExecutor,
    caller: OwnerCaller,
    time: string,
    readMode: OwnerAuthorityReadMode = "locking",
  ): Promise<OwnerProcessorAssignment | undefined> {
    const current = await resolveCurrentAssignment(tx, caller, time, readMode);
    if (!current || !("kind" in current.binding)) return undefined;
    const { binding, grants } = current;
    return {
      kind: "processor",
      ownerId,
      workerId: binding.workerId,
      assignmentId: binding.assignmentId,
      sessionId: binding.sessionId,
      namespace: binding.namespace,
      processorId: binding.processorId,
      sourceEventId: binding.sourceEventId,
      deliveryId: binding.deliveryId,
      dispatchAttemptId: binding.dispatchAttemptId,
      ctxGranted: grants.ctx === true,
      settlementGranted: grants.settlement === true,
    };
  }
  function enqueueScheduled(data: OwnerScheduledAssignment) {
    if (!ready()) unavailable();
    if (!pending.has(data.deliveryId) && pending.size >= maxPending) {
      unavailable("Owner scheduling queue is full; durable alarm retained.");
    }
    const existing = pending.get(data.deliveryId);
    if (existing) {
      if (!same(existing, data)) {
        unavailable("Queued delivery identity changed.");
      }
    } else {
      pending.set(data.deliveryId, copy(data));
      placements.set(
        data.deliveryId,
        ("kind" in data
            ? processorConfiguration?.selects(data.processorId)
            : localConfiguration?.selects(data.actionId))
          ? "owner-local"
          : "worker",
      );
    }
    queueMicrotask(pump);
  }
  function enqueue(value: OwnerJson) {
    const data = copy(value) as unknown as {
      namespace: string;
      actionId: string;
      executionId: string;
      eventId: string;
      deliveryId: string;
    };
    enqueueScheduled({
      namespace: data.namespace,
      actionId: data.actionId,
      executionId: data.executionId,
      sourceEventId: data.eventId,
      deliveryId: data.deliveryId,
    });
  }
  const deliveryAlarm = (namespace: string, id: string) =>
    JSON.stringify(["host.delivery", namespace, id]);
  type ScheduledRow = {
    id: string;
    event_id: string;
    namespace: string;
    consumer_id: string;
    status: string;
    attempts: number;
    available_at: string;
    due?: boolean;
    lease_expires_at: string | null;
    metadata: Record<string, OwnerJson>;
    type: string;
  };
  function scheduledReference(row: ScheduledRow): OwnerScheduledAssignment {
    const processor = registry.processorForConsumer(row.consumer_id);
    if (processor) {
      return {
        kind: "processor",
        processorId: processor.id,
        namespace: row.namespace,
        sourceEventId: row.event_id,
        deliveryId: row.id,
      };
    }
    const actionId = row.metadata.actionId;
    const executionId = row.metadata.actionRunId;
    text(actionId);
    text(executionId);
    if (
      row.type !== "copilotz.owner.action.requested" ||
      row.consumer_id !== `registered:${actionId}` ||
      !Object.values(registry.actions).some((action) => action.id === actionId)
    ) {
      unavailable("Delivery requires an unsupported registered capability.");
    }
    return {
      namespace: row.namespace,
      actionId,
      executionId,
      sourceEventId: row.event_id,
      deliveryId: row.id,
    };
  }
  async function setDeliveryAlarm(
    context: OwnerCommandContext,
    namespace: string,
    id: string,
    due: string,
  ) {
    await context.tx.query(
      `INSERT INTO ${ownerTables.alarms}(owner,name,due_at) VALUES($1,$2,$3::timestamptz) ON CONFLICT(owner,name) DO UPDATE SET due_at=EXCLUDED.due_at`,
      [ownerId, deliveryAlarm(namespace, id), due],
    );
  }
  /** Exhaustive bounded selection, including deliveries attached to older events.
   * All durable wakes share the command transaction; only references escape. */
  function withDeliveryAlarms(
    handler: OwnerCommandHandler,
  ): OwnerCommandHandler {
    return async (intent, context) => {
      const run = async () => {
        const result = await handler(intent, context);
        const starting = [
          "execution.claim",
          "processor.claim",
          "owner.local-start",
          "owner.local-processor-start",
        ].includes(context.command.kind);
        const resultRecord = result as {
          deliveryId?: unknown;
          binding?: { deliveryId?: unknown };
        } | null;
        const claimedDeliveryId = starting
          ? resultRecord?.deliveryId ?? resultRecord?.binding?.deliveryId
          : undefined;
        if (starting && typeof claimedDeliveryId !== "string") {
          unavailable("Start result lacks its exact delivery.");
        }
        const rows = (await context.tx.query<ScheduledRow>(
          `SELECT d.id,d.event_id,d.consumer_id,d.status,d.attempts,d.available_at::text AS available_at,(d.available_at <= $3::timestamptz) AS due,d.lease_expires_at::text AS lease_expires_at,e.namespace,e.metadata,e.type FROM ${tables.event_deliveries} d JOIN ${tables.events} e ON e.id=d.event_id WHERE e.owner_id=$1 AND d.status IN ('pending','retry_wait','leased') ORDER BY d.available_at,d.created_at,d.id LIMIT $2`,
          [ownerId, maxPending + 1, context.commandTime],
        )).rows;
        if (rows.length > maxPending) {
          unavailable("Owner durable delivery capacity exceeded.");
        }
        if (
          starting &&
          !rows.some((row) =>
            row.id === claimedDeliveryId && row.status === "leased"
          )
        ) unavailable("Started delivery is not active.");
        const due: OwnerScheduledAssignment[] = [];
        for (const row of rows) {
          const ref = scheduledReference(row);
          const deadline = row.status === "leased"
            ? row.lease_expires_at
            : row.available_at;
          if (row.status === "leased") {
            if (deadline !== null) {
              unavailable(
                "Timed in-flight owner history requires explicit migration.",
              );
            }
            // A fresh claim/start consumes only its own availability wake.
            // Unrelated commands must not hide an anomalous running-job alarm.
            if (claimedDeliveryId === row.id) {
              await context.tx.query(
                `DELETE FROM ${ownerTables.alarms} WHERE owner=$1 AND name=$2`,
                [ownerId, deliveryAlarm(row.namespace, row.id)],
              );
            }
            continue;
          }
          if (!deadline) unavailable("Leased delivery has no deadline.");
          await setDeliveryAlarm(context, row.namespace, row.id, deadline);
          if (
            row.status !== "leased" &&
            row.due === true
          ) due.push(ref);
        }
        context.afterCommit(() => {
          for (const ref of due) enqueueScheduled(ref);
        });
        return result;
      };
      return localBundle
        ? await commandContexts.run(context, run)
        : await run();
    };
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
    authorizeControl(_tx, caller, target) {
      if (ready()) {
        assertControl(caller);
        return true;
      }
      assertControl(caller, "startup-settlement");
      return !closed && !abort.signal.aborted && owner.state === "acquired" &&
        same(controlTokens.get(caller.hostControl as string)?.target, target);
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
      // The in-command wrapper already persisted the wake. A callback is only a
      // hint; derive current delivery facts again under the owner fence.
      queueMicrotask(() => {
        void wakeAlarms().catch(report);
      });
    },
    dispatchWork: () =>
      Promise.reject(new Error("Direct dispatch is not an owner capability.")),
    dispatchDelivery: () =>
      Promise.reject(new Error("Direct delivery dispatch is unavailable.")),
    dispatchRecoverable: () =>
      Promise.reject(new Error("Restart recovery is unavailable.")),
    settleOutputs: () =>
      Promise.reject(new Error("Stream output is unavailable.")),
    awaitScopeProgress: () => Promise.resolve(false),
    shutdown: () => Promise.resolve(),
  };
  let preparations: ReturnType<typeof createOwnerPreparations> | undefined;
  let preparedHistory: readonly OwnerPreparedHistoryRegistration[] | undefined;
  function authorizePreparedInput(
    tx: SqlExecutor,
    context: OwnerPreparedInputContext,
  ) {
    // Execution has already authenticated live or exact private control-start
    // authority. Keep that genuine caller for original-source policies; a local
    // assignment is deliberately not active yet during the claim-time check.
    if (!preparations) unavailable("Prepared input authority is unavailable.");
    // Execution/child modules own their current assignment checks. Calling
    // authorizeLive here would recursively reenter this prepared-input gate.
    return preparations.authorizeCaptured(tx, context);
  }
  const execution = createOwnerExecutionCommands({
    ownerId,
    schema,
    session,
    registry,
    catalog,
    executor,
    scheduleSettlement: settlement.schedule,
    resolveAssignment: resolveExecution,
    isCurrentAssignment(caller, assignment) {
      if (!ready()) return false;
      if (assignment.placement === "owner-local") {
        const actual = local?.current(caller);
        return !!actual && ready() &&
          Object.entries(actual).every(([key, value]) =>
            (assignment as unknown as Record<string, unknown>)[key] === value
          );
      }
      const actual = bridge.currentStarted(caller);
      return !!actual && !("kind" in actual) && ready() &&
        actual.workerId === assignment.workerId &&
        actual.assignmentId === assignment.assignmentId &&
        actual.sessionId === assignment.sessionId &&
        actual.dispatchAttemptId === assignment.dispatchAttemptId &&
        actual.deliveryId === assignment.deliveryId &&
        actual.namespace === assignment.namespace &&
        actual.actionId === assignment.actionId &&
        actual.executionId === assignment.invocation.actionRunId &&
        actual.sourceEventId === assignment.invocation.identity?.causationId;
    },
    ...(localConfiguration
      ? {
        local: {
          authorizeStart: (tx, caller, binding, time) =>
            local?.execution.authorizeStart(tx, caller, binding, time) ?? false,
          reserveLocal: (context, binding) => {
            if (!local) unavailable();
            return local.execution.reserveLocal(context, binding);
          },
          retireLocal: (context, binding) => {
            if (!local) unavailable();
            return local.execution.retireLocal(context, binding);
          },
        },
      }
      : {}),
    authorizePreparedInput,
    authorizeInput: (tx, assignment, value, time) => {
      if (assignment.placement === "owner-local") {
        if (!local) unavailable();
        return local.input(tx, assignment, value, time);
      }
      return policy.input(tx, copy(assignment), copy(value), time);
    },
  });
  const processor = createOwnerProcessorCommands({
    ownerId,
    schema,
    session,
    registry,
    catalog,
    resolveAssignment: resolveProcessor,
    ...(processorConfiguration
      ? {
        local: {
          resolveAssignment: (tx, caller, time, readMode) =>
            localProcessor?.resolve(tx, caller, time, readMode),
          authorizeStart: (tx, caller, binding, facts, time) =>
            localProcessor?.processor.authorizeStart(
              tx,
              caller,
              binding,
              facts,
              time,
            ),
          authorizeEvent: (tx, assignment, event, data, time) => {
            if (!localProcessor) unavailable();
            return localProcessor.event(tx, assignment, event, data, time);
          },
          isCurrent: (caller, binding, ordinal, phase) =>
            localProcessor?.processor.isCurrent(
              caller,
              binding,
              ordinal,
              phase,
            ) === true,
          reserveLocal: (context, binding) => {
            if (!localProcessor) unavailable();
            return localProcessor.processor.reserveLocal(context, binding);
          },
          retireLocal: (context, binding) => {
            if (!localProcessor) unavailable();
            return localProcessor.processor.retireLocal(context, binding);
          },
        },
      }
      : {}),
    authorizeEvent(tx, assignment, event, data, time) {
      if (!policy.processorEvent) {
        unavailable("Current Processor event policy is unavailable.");
      }
      return policy.processorEvent(
        tx,
        copy(assignment),
        copy(event),
        copy(data),
        time,
      );
    },
    scheduleSettlement: settlement.schedule,
    async scheduleRetry(context, delivery) {
      const assigned = context.caller.principal.kind === "owner-local"
        ? {
          deliveryId: delivery.id,
          namespace: await localProcessor?.retryNamespace(context, delivery),
        }
        : await resolveProcessor(
          context.tx,
          context.caller,
          context.commandTime,
        );
      if (
        !assigned || !assigned.namespace || assigned.deliveryId !== delivery.id
      ) unavailable();
      await setDeliveryAlarm(
        context,
        assigned.namespace,
        delivery.id,
        delivery.availableAt,
      );
      context.afterCommit(() => {
        void wakeAlarms().catch(report);
      });
    },
  });
  async function resolveInvocation(
    tx: SqlExecutor,
    caller: OwnerCaller,
    time: string,
    readMode: OwnerAuthorityReadMode = "locking",
  ): Promise<OwnerChildActionBinding | undefined> {
    if (caller.principal.kind === "owner-local") {
      if (local?.current(caller)) {
        const assignment = await execution.authorizeLive(
          tx,
          caller,
          time,
          readMode,
        );
        return assignment.placement === "owner-local"
          ? { kind: "action", assignment }
          : undefined;
      }
      if (!localProcessor?.current(caller)) return undefined;
      const { assignment } = await processor.authorizeLocalLive(
        tx,
        caller,
        time,
        readMode,
      );
      return "placement" in assignment &&
          assignment.placement === "owner-local"
        ? { kind: "processor", assignment }
        : undefined;
    }
    const current = await bridge.resolveStarted(tx, caller, readMode);
    if (!current) return undefined;
    return "kind" in current
      ? {
        kind: "processor",
        assignment: (await processor.authorizeLive(tx, caller, time, readMode))
          .assignment,
      }
      : {
        kind: "action",
        assignment: workerAssignment(
          await execution.authorizeLive(tx, caller, time, readMode),
        ),
      };
  }
  const readCollections = createOwnerCollectionRead({
    schema,
    registry,
    resolve: resolveInvocation,
    authorize: policy.collectionRead,
  });
  const child = createOwnerChildActions({
    ownerId,
    schema,
    session,
    registry,
    catalog,
    maxPendingDeliveries: maxPending,
    authorizePreparedInput,
    isCurrentParent(caller, parent) {
      if (!ready()) return false;
      const a = parent.assignment;
      if ("placement" in a && a.placement === "owner-local") {
        if (caller.principal.kind !== "owner-local" || a.ctxGranted !== true) {
          return false;
        }
        const actual = parent.kind === "action"
          ? local?.current(caller)
          : localProcessor?.current(caller);
        if (!actual || !ready()) return false;
        const reference = "reference" in actual ? actual.reference : actual;
        if (
          !Object.entries(reference).every(([key, value]) =>
            (a as unknown as Record<string, unknown>)[key] === value
          )
        ) return false;
        return parent.kind === "action" ||
          ("attemptOrdinal" in actual && "attemptOrdinal" in a &&
            actual.attemptOrdinal === a.attemptOrdinal);
      }
      if (caller.principal.kind !== "worker" || !("workerId" in a)) {
        return false;
      }
      const actual = bridge.currentStarted(caller);
      if (
        !actual || !ready() || a.ownerId !== ownerId || a.ctxGranted !== true ||
        actual.workerId !== a.workerId ||
        actual.assignmentId !== a.assignmentId ||
        actual.sessionId !== a.sessionId ||
        actual.dispatchAttemptId !== a.dispatchAttemptId ||
        actual.deliveryId !== a.deliveryId || actual.namespace !== a.namespace
      ) return false;
      // currentStarted already matches the complete captured caller tuple,
      // including worker provisioning attempt and session generation.
      return parent.kind === "processor"
        ? "kind" in actual &&
          actual.processorId === parent.assignment.processorId &&
          actual.sourceEventId === parent.assignment.sourceEventId
        : !("kind" in actual) &&
          actual.actionId === parent.assignment.actionId &&
          actual.executionId === parent.assignment.invocation.actionRunId &&
          actual.sourceEventId ===
            parent.assignment.invocation.identity?.causationId;
    },
    resolveParent: resolveInvocation,
    authorizeChild(tx, _caller, parent, actionId, time) {
      if (!policy.child) {
        unavailable("Current child Action policy is unavailable.");
      }
      return policy.child(tx, copy(parent), actionId, time);
    },
    schedule: (reference) => enqueue(reference),
  });
  if (preparation) {
    const source = createOwnerPreparationRecordSource({
      ...preparation.records,
      ownerId,
      schema,
      registry,
    });
    preparations = createOwnerPreparations({
      ownerId,
      schema,
      registry,
      children: child,
      source,
      preparations: preparation.registrations,
      projectResource: preparation.projectResource,
      authorizeResource: preparation.authorizeResource,
      maxPendingRenders: preparation.maxPendingRenders,
      renderTimeoutMs: preparation.renderTimeoutMs,
      maxBytes: preparation.maxBytes,
    });
    const sources = new Map(
      source.historySources().map((value) => [value.name, value]),
    );
    preparedHistory = preparations.historyRegistrations().map(
      ({ source, ...value }) => {
        const registeredSource = sources.get(source);
        if (!registeredSource) {
          throw new TypeError("Preparation source is not registered.");
        }
        return { ...value, source: registeredSource };
      },
    );
  }
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
    isCurrentEffect(caller, ref) {
      if (!ready()) return false;
      if (caller.principal.kind === "owner-local") {
        const actual = local?.current(caller);
        return !!actual && ready() && actual.namespace === ref.namespace &&
          actual.actionRunId === ref.actionRunId;
      }
      if (caller.principal.kind !== "worker") return false;
      const actual = bridge.currentStarted(caller);
      return !!actual && !("kind" in actual) && ready() &&
        actual.namespace === ref.namespace &&
        actual.executionId === ref.actionRunId;
    },
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
    catalog,
    scope(context) {
      const scope = collectionScopes.get(context.tx);
      collectionScopes.delete(context.tx);
      if (!scope) unavailable();
      return scope;
    },
  });
  const terminal = terminalConfiguration
    ? createOwnerHostTerminalRecovery({
      configuration: terminalConfiguration,
      ownerId,
      schema,
      session,
      registry,
      catalog,
      executor,
      currentOwner() {
        return !initialized && !closed && !transport && !abort.signal.aborted &&
            owner.state === "acquired" && owner.epoch !== undefined
          ? { ownerId, epoch: owner.epoch, holderId }
          : undefined;
      },
      scheduleSettlement: (context, scope) =>
        settlement.schedule(context, scope),
    })
    : undefined;
  const startup = createOwnerStartupProof({
    ownerId,
    schema,
    registry,
    ...(initialization === "fresh" || preparedHistory === undefined
      ? {}
      : { prepared: preparedHistory }),
    ...(initialization === "fresh" || namespaceInventory === undefined
      ? {}
      : { namespaces: namespaceInventory }),
    ...(initialization === "fresh" ? {} : {
      maxItems: initialization.maxItems,
      maxBytes: initialization.maxBytes,
    }),
    authorizeControl(_tx, caller) {
      assertControl(caller, "startup");
      return !initialized && !closed && !abort.signal.aborted;
    },
  });
  async function validateSchemas(tx: SqlExecutor) {
    await validateCopilotzSchema(tx, schema);
    await validateOperationCatalog({
      query: tx.query.bind(tx),
      transaction(): never {
        throw new Error("Nested validation transactions are forbidden.");
      },
    }, schema);
    await validateOwnerCommandSchema(tx, schema, ownerId);
    await validateOwnerAssignments(tx, schema);
  }
  async function assertFreshEmpty(tx: SqlExecutor, committed: boolean) {
    if (owner.epoch !== 1) {
      unavailable("Fresh host cannot take over an existing epoch.");
    }
    for (
      const table of [
        tables.nodes,
        tables.edges,
        tables.events,
        tables.event_bodies,
        tables.event_deliveries,
        tables.open_actions,
        operationTables.operations,
        operationTables.operationEvents,
        operationTables.operationStreams,
        operationTables.selectionHeads,
        operationTables.selectionOperations,
        assignmentTable,
        ownerTables.alarms,
      ]
    ) {
      if ((await tx.query(`SELECT 1 FROM ${table} LIMIT 1`)).rows.length) {
        unavailable("Fresh owner host requires empty tables.");
      }
    }
    for (const name of ["content_bodies", "content_body_parts"]) {
      if (
        (await tx.query<{ relation: string | null }>(
          "SELECT to_regclass($1)::text AS relation",
          [`${quoteEventIdentifier(schema)}.${quoteEventIdentifier(name)}`],
        )).rows[0]?.relation
      ) {
        unavailable(
          "Fresh owner host does not support retained content storage.",
        );
      }
    }
    if (!committed) {
      for (const table of [ownerTables.receipts, ownerTables.receiptReaders]) {
        if ((await tx.query(`SELECT 1 FROM ${table} LIMIT 1`)).rows.length) {
          unavailable("Fresh owner host requires empty tables.");
        }
      }
      return;
    }
    const principal = ownerPrincipalIdentity({
      kind: "owner-control",
      ownerId,
      epoch: owner.epoch,
      holderId,
    });
    const predicate =
      `owner=$1 AND domain='occurrence' AND key=$2 AND principal_kind=$3 AND principal_id=$4`;
    const params = [ownerId, freshKey, principal.kind, principal.id];
    for (
      const [table, extra] of [[
        ownerTables.receipts,
        ` AND kind='host.initialize-fresh' AND intent='null'::jsonb AND result='null'::jsonb`,
      ], [ownerTables.receiptReaders, ""]]
    ) {
      if (
        (await tx.query(
          `SELECT 1 FROM ${table} WHERE NOT (${predicate}${extra}) LIMIT 1`,
          params,
        )).rows.length ||
        !(await tx.query(
          `SELECT 1 FROM ${table} WHERE ${predicate}${extra} LIMIT 1`,
          params,
        )).rows.length
      ) {
        unavailable("Fresh initialization receipt history is incompatible.");
      }
    }
  }
  const owner: OwnerCommandBoundary = createOwnerCommandBoundary({
    currentAuthorizationKinds: [
      OWNER_CHILD_ACTION_ADMISSION,
      OWNER_CHILD_ACTION_RESULT,
      ...(preparations ? [OWNER_CHILD_ACTION_PREPARATION] : []),
      "effect.begin",
      "effect.confirm",
      "effect.notStarted",
      "effect.state",
      "collections",
      OWNER_COLLECTION_READ,
    ],
    isCurrentAuthorization(tx, caller, command, time) {
      return command.kind === OWNER_CHILD_ACTION_ADMISSION ||
          command.kind === OWNER_CHILD_ACTION_RESULT ||
          command.kind === OWNER_CHILD_ACTION_PREPARATION
        ? child.isCurrentAuthorization(tx, caller, command, time)
        : command.kind.startsWith("effect.")
        ? effects.isCurrentAuthorization(tx, caller, command, time)
        : command.kind === "collections" ||
            command.kind === OWNER_COLLECTION_READ
        ? ready() && (caller.principal.kind === "owner-local"
          ? !!(local?.current(caller) ?? localProcessor?.current(caller))
          : !!bridge.currentStarted(caller)) &&
          ready()
        : true;
    },
    session,
    schema,
    ownerId,
    holderId,
    now,
    maxQueue: maxPending,
    maxPostCommitGroups: maxPending,
    handlers: {
      ...startup.handlers,
      ...(terminal
        ? {
          ...terminal.handlers,
          [OWNER_STARTUP_REPAIR]: terminal.wrapRepair(
            startup.handlers[OWNER_STARTUP_REPAIR],
          ),
        }
        : {}),
      "host.initialize-fresh": async (_input, context) => {
        // Joining the command transaction does not open a nested transaction.
        await provisionCollectionIndexes(
          {
            query: context.tx.query.bind(context.tx),
            transaction: (run) => run(context.tx),
          },
          schema,
          collectionDefinitions,
        );
        await validateCollectionIndexes(
          context.tx,
          schema,
          collectionDefinitions,
        );
        return null;
      },
      ...bridge.assignmentHandlers,
      ...Object.fromEntries(
        Object.entries(execution.handlers).map((
          [kind, handler],
        ) => [kind, withDeliveryAlarms(handler)]),
      ),
      ...Object.fromEntries(
        Object.entries(processor.handlers).map((
          [kind, handler],
        ) => [kind, withDeliveryAlarms(handler)]),
      ),
      ...effects.handlers,
      ...settlement.handlers,
      collections: withDeliveryAlarms(collection),
      [OWNER_CHILD_ACTION_ADMISSION]: withDeliveryAlarms(
        async (intent, context) => {
          // This check runs only for a fresh admission, after compatible receipt
          // lookup. This is fail-fast protection, not a capacity reservation:
          // concurrent work can still take the spare slot after child admission.
          if (active.size >= maxActive) {
            unavailable("Child Action execution capacity is full.");
          }
          return await child.handler(intent, context);
        },
      ),
      ...(preparations
        ? {
          [OWNER_CHILD_ACTION_PREPARATION]: withDeliveryAlarms(
            async (intent, context) => {
              if (active.size >= maxActive) {
                unavailable("Child Action execution capacity is full.");
              }
              return await preparations!.handler(intent, context);
            },
          ),
        }
        : {}),
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
          {
            status: string;
            settlement_scope_id: string;
            namespace: string;
            consumer_id: string;
            available_at: string;
          }
        >(
          `SELECT d.status,d.settlement_scope_id,d.consumer_id,d.available_at,e.namespace FROM ${tables.event_deliveries} d JOIN ${tables.events} e ON e.id=d.event_id WHERE d.id=$1 AND e.owner_id=$2 FOR UPDATE OF d`,
          [id, ownerId],
        )).rows[0];
        if (
          row?.status === "retry_wait" &&
          registry.processorForConsumer(row.consumer_id)
        ) {
          await setDeliveryAlarm(context, row.namespace, id, row.available_at);
          return { status: row.status };
        }
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
      [OWNER_COLLECTION_READ]: readCollections,
      ...startup.projections,
      ...(terminal
        ? {
          [OWNER_STARTUP_PROOF]: terminal.wrapProof(
            startup.projections[OWNER_STARTUP_PROOF],
          ),
        }
        : {}),
      ...execution.projections,
      ...processor.projections,
      [OWNER_CHILD_ACTION_RESULT]: child.projection,
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
      "host.schema-ready": async (_input, context) => {
        await validateSchemas(context.tx);
        await validateCollectionIndexes(
          context.tx,
          schema,
          collectionDefinitions,
        );
        if (initialization === "fresh") {
          await assertFreshEmpty(context.tx, true);
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
            const delivery = (await context.tx.query<ScheduledRow>(
              `SELECT d.id,d.event_id,d.consumer_id,d.status,d.attempts,d.available_at,d.lease_expires_at,e.namespace,e.metadata,e.type FROM ${tables.event_deliveries} d JOIN ${tables.events} e ON e.id=d.event_id WHERE d.id=$1 AND e.namespace=$2 AND e.owner_id=$3`,
              [id, namespace, ownerId],
            )).rows[0];
            if (!delivery) {
              unavailable("Owner alarm has no matching durable delivery.");
            }
            if (
              delivery.status === "leased" && delivery.lease_expires_at === null
            ) {
              const error = new Error(
                "Active owner attempt retained an inconsistent expiry alarm; explicit recovery is required.",
              );
              stop(error);
              throw error;
            }
            found.push({
              kind: "delivery",
              reference: scheduledReference(delivery),
              status: delivery.status,
              attempts: delivery.attempts,
            });
          } else unavailable("Owner alarm requires an unsupported capability.");
        }
        return found;
      },
      "host.assignment-grants": async (input, context) => {
        const assignment = await resolveCurrentAssignment(
          context.tx,
          input as OwnerCaller,
          context.commandTime,
        );
        return assignment
          ? {
            ctx: assignment.grants.ctx === true,
            settlement: assignment.grants.settlement === true,
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
      [OWNER_CHILD_ACTION_ADMISSION]: child.inputDefinition,
      ...(preparations
        ? { [OWNER_CHILD_ACTION_PREPARATION]: preparations.inputDefinition }
        : {}),
    },
    async authorize(tx, caller, command, time, normalized) {
      return await commandContexts.authorize(
        tx,
        caller,
        command,
        time,
        async () => {
          if (command.kind === "host.initialize-fresh") {
            assertControl(caller, "fresh");
            if (
              initialization !== "fresh" || initialized ||
              command.domain !== "occurrence" || command.key !== freshKey ||
              command.intent !== null
            ) unavailable();
            await validateSchemas(tx);
            // Runs before receipt lookup, so a duplicate cannot bypass emptiness.
            await assertFreshEmpty(tx, false);
            return;
          }
          if (command.kind === "host.schema-ready") {
            assertControl(caller, "schema");
            if (initialized || command.intent !== null) unavailable();
            return;
          }
          if (
            command.kind === OWNER_STARTUP_REPAIR ||
            command.kind === OWNER_STARTUP_PROOF
          ) {
            if (initialization === "fresh" || initialized) unavailable();
            return await startup.authorize(tx, caller, command, time);
          }
          if (
            !ready() &&
            (command.kind === OWNER_OPERATION_SETTLEMENT ||
              command.kind === OWNER_OPERATION_READINESS)
          ) {
            assertControl(caller, "startup-settlement");
            return await settlement.authorize(tx, caller, command, time);
          }
          if (command.kind === OWNER_LOST_ACTION_RECOVERY) {
            if (!terminal || initialization === "fresh" || initialized) {
              unavailable();
            }
            return await terminal.authorize(tx, caller, command, time);
          }
          if (command.kind.startsWith("host.")) {
            assertControl(caller);
            if (!ready()) unavailable();
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
              const sessionView = transport!.sessions.get(binding.workerId);
              if (
                !sessionView ||
                sessionView.connectionId !== binding.sessionId ||
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
              !request || typeof request !== "object" ||
              Array.isArray(request) ||
              Object.keys(request).some((key) =>
                !["actionAlias", "input", "operationKey"].includes(key)
              ) || !Object.hasOwn(request, "input")
            ) unavailable();
            text(request.actionAlias);
            if (request.operationKey !== undefined) text(request.operationKey);
            const scope = await scopeFor(tx, caller, time);
            if (
              !scope.allowedActions.includes(request.actionAlias)
            ) unavailable();
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
          if (command.kind === OWNER_CHILD_ACTION_PREPARATION) {
            if (!preparations) unavailable("Named preparation is unavailable.");
            return await preparations.authorize(
              tx,
              caller,
              command,
              time,
              normalized,
            );
          }
          if (
            command.kind === OWNER_CHILD_ACTION_ADMISSION ||
            command.kind === OWNER_CHILD_ACTION_RESULT
          ) {
            return await child.authorize(tx, caller, command, time, normalized);
          }
          if (
            command.kind === "owner.local-processor-start" ||
            command.kind.startsWith("processor.")
          ) {
            return await processor.authorize(tx, caller, command, time);
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
          // The read handler owns request/scope/live checks lexically.
          if (command.kind === OWNER_COLLECTION_READ) return;
          if (command.kind === "collections") {
            if (caller.principal.kind === "owner-local") {
              if (
                localProcessor && await localProcessor.resolve(tx, caller, time)
              ) {
                const live = await processor.authorizeLocalLive(
                  tx,
                  caller,
                  time,
                );
                const { assignment, delivery, event } = live;
                const prefix = `delivery:${delivery.id}:`;
                if (
                  command.domain !== "logical" ||
                  !command.key.startsWith(prefix) ||
                  command.key.length <= prefix.length
                ) unavailable();
                const conditions = await localProcessor.collections(
                  tx,
                  assignment,
                  copy(command.intent) as unknown as OwnerCollectionIntent,
                  time,
                );
                const rechecked = await processor.authorizeLocalLive(
                  tx,
                  caller,
                  time,
                );
                if (
                  !same(rechecked.assignment, assignment) ||
                  rechecked.delivery.id !== delivery.id ||
                  rechecked.event.id !== event.id
                ) unavailable();
                const {
                  ctxGranted: _ctx,
                  settlementGranted: _settlement,
                  attemptOrdinal: _ordinal,
                  ...attempt
                } = assignment;
                collectionScopes.set(tx, {
                  namespace: assignment.namespace,
                  identity: {
                    causationId: event.id,
                    correlationId: event.correlationId,
                    settlementScopeId: delivery.settlementScopeId,
                    ...(delivery.actionScopeId
                      ? { actionScopeId: delivery.actionScopeId }
                      : {}),
                    deliveryLease: {
                      deliveryId: delivery.id,
                      owner: assignment.attemptId,
                    },
                    metadata: {
                      sourceEventId: event.id,
                      sourceDeliveryId: delivery.id,
                      sourceConsumerId: delivery.consumerId,
                    },
                  },
                  conditions: conditions.conditions,
                  attempt,
                });
                return;
              }
              if (!local) unavailable();
              const assignment = await execution.authorizeLive(
                tx,
                caller,
                time,
              );
              if (assignment.placement !== "owner-local") unavailable();
              const {
                invocation,
                ctxGranted: _ctx,
                settlementGranted: _settlement,
                ...attempt
              } = assignment;
              const prefix = `${invocation.operationKey}/`;
              if (
                command.domain !== "logical" ||
                !command.key.startsWith(prefix) ||
                command.key.length <= prefix.length
              ) unavailable();
              const conditions = await local.collections(
                tx,
                assignment,
                copy(command.intent) as unknown as OwnerCollectionIntent,
                time,
              );
              const rechecked = await execution.authorizeLive(tx, caller, time);
              if (
                rechecked.placement !== "owner-local" ||
                rechecked.attemptId !== assignment.attemptId ||
                rechecked.deliveryId !== assignment.deliveryId ||
                rechecked.sourceEventId !== assignment.sourceEventId ||
                !same(rechecked.invocation, invocation)
              ) unavailable();
              collectionScopes.set(tx, {
                namespace: assignment.namespace,
                identity: {
                  ...copy(invocation.identity),
                  deliveryLease: {
                    deliveryId: assignment.deliveryId,
                    owner: assignment.attemptId,
                  },
                },
                conditions: conditions.conditions,
                attempt,
              });
              return;
            }
            const binding = await bridge.resolveStarted(tx, caller);
            if (!binding) unavailable();
            let assignment:
              | OwnerWorkerExecutionAssignment
              | OwnerProcessorAssignment;
            let prefix: string;
            let identity: OwnerCollectionScope["identity"];
            if ("kind" in binding) {
              const live = await processor.authorizeLive(tx, caller, time);
              assignment = live.assignment;
              prefix = `delivery:${live.delivery.id}:`;
              identity = {
                causationId: live.event.id,
                correlationId: live.event.correlationId,
                settlementScopeId: live.delivery.settlementScopeId,
                ...(live.delivery.actionScopeId
                  ? { actionScopeId: live.delivery.actionScopeId }
                  : {}),
                deliveryLease: {
                  deliveryId: live.delivery.id,
                  owner: live.assignment.dispatchAttemptId,
                },
                metadata: {
                  sourceEventId: live.event.id,
                  sourceDeliveryId: live.delivery.id,
                  sourceConsumerId: live.delivery.consumerId,
                },
              };
            } else {
              assignment = workerAssignment(
                await execution.authorizeLive(tx, caller, time),
              );
              prefix = `${assignment.invocation.operationKey}/`;
              identity = {
                ...copy(assignment.invocation.identity),
                deliveryLease: {
                  deliveryId: assignment.deliveryId,
                  owner: assignment.dispatchAttemptId,
                },
              };
            }
            if (
              command.domain !== "logical" ||
              !command.key.startsWith(prefix) ||
              command.key.length <= prefix.length
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
              identity,
              conditions: conditions.conditions,
              attempt: {
                placement: "worker",
                ownerId,
                workerId: assignment.workerId,
                assignmentId: assignment.assignmentId,
                sessionId: assignment.sessionId,
                dispatchAttemptId: assignment.dispatchAttemptId,
                deliveryId: assignment.deliveryId,
              },
            });
            return;
          }
          return await execution.authorize(
            tx,
            caller,
            command,
            time,
            normalized,
          );
        },
      );
    },
    authenticateReceipt(_tx, caller) {
      if (
        ![...receiptCalls].some((context) =>
          caller.principal.kind === "worker" &&
          context.fence.identity.workerId === caller.principal.workerId &&
          current(context.fence) && !context.signal.aborted
        )
      ) unavailable();
    },
    onPostCommitError: report,
  });
  if (snapshotConfiguration) {
    snapshots = createOwnerSnapshotResources({
      session,
      schema,
      registry,
      owner,
      ownerId,
      holderId,
      now,
      idleTimeoutMs: snapshotConfiguration.idleTimeoutMs as number,
      maxLifetimeMs: snapshotConfiguration.maxLifetimeMs as number,
      maxPendingReads: snapshotConfiguration.maxPendingReads as number,
      authorizeHistorical: snapshotConfiguration
        .authorizeHistorical as OwnerHistoricalReadPolicy,
      resolve: resolveInvocation,
      capture(caller) {
        return caller.principal.kind === "owner-local"
          ? local?.captureLifetime(caller) ??
            localProcessor?.captureLifetime(caller)
          : bridge.captureStartedLifetime(caller);
      },
    });
  }
  // Boundary self-fencing (including ingress COMMIT uncertainty) can happen
  // without a dispatched Work failure. Observe the authoritative transition;
  // diagnostics and transport capacity refusals are not terminal signals.
  void owner.stopped.then(() => {
    if (!closed && !abort.signal.aborted) {
      stop(new Error("Owner command boundary stopped."));
    }
  });
  function pump() {
    if (pumping || !ready() || !transport) return;
    pumping = true;
    try {
      for (const [key, ref] of pending) {
        if (active.size >= maxActive) break;
        if (active.has(key)) continue;
        if (placements.get(key) === "owner-local") {
          const selected = "kind" in ref ? localProcessor : local;
          if (!selected) unavailable();
          const task = selected.run(copy(ref)).catch((error) => stop(error));
          trackTask(task);
          continue;
        }
        const reservation = reserveActive(key, "worker");
        if (!reservation) break;
        const task = (async () => {
          let dispatched = false;
          try {
            const admission = new AbortController();
            const timer = setTimeout(
              () =>
                admission.abort(
                  new Error("Owner dispatch admission wait expired."),
                ),
              dispatchWaitMs,
            );
            const handle = await (async () => {
              try {
                // Keep waiting on the real dispatch promise, including a
                // noncooperative implementation, so its reservation stays bounded.
                return await bridge.dispatch(transport!, {
                  workload: "kind" in ref
                    ? OWNER_PROCESSOR_WORKLOAD
                    : OWNER_ACTION_WORKLOAD,
                  body: new Uint8Array(),
                  signal: AbortSignal.any([abort.signal, admission.signal]),
                }, key);
              } finally {
                clearTimeout(timer);
              }
            })();
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
            placements.delete(key);
          } catch (error) {
            if (dispatched) stop(error);
            else report(error);
          } finally {
            reservation.release();
          }
        })();
        trackTask(task);
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
          const ref = alarm.reference as OwnerScheduledAssignment;
          const id = ref.deliveryId;
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
            placements.delete(id);
          } else if (
            (alarm.status === "pending" && alarm.attempts === 0) ||
            ("kind" in ref &&
              ["pending", "retry_wait"].includes(String(alarm.status)))
          ) {
            enqueueScheduled(ref);
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
    ...(snapshots
      ? {
        snapshots: {
          resolveCaller(context: OwnerWorkerCallContext, id: string) {
            if (id !== ownerId || !ready()) return undefined;
            return bridge.resolveAssignment(context, id)?.caller;
          },
          async run(
            caller: OwnerCaller,
            request: import("../owner/connection.ts").OwnerSnapshotCall,
            signal: AbortSignal,
          ): Promise<OwnerJson> {
            if (request.operation === "open") {
              return await snapshots!.open(caller, signal);
            }
            if (request.operation === "read") {
              return await snapshots!.read(
                request.id,
                caller,
                request.request,
                signal,
              );
            }
            await snapshots!.close(request.id, caller);
            return null;
          },
        },
      }
      : {}),
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
        principal: {
          kind: "worker",
          workerId: witness.fence.identity.workerId,
        },
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
      snapshots?.assertOrdinaryAllowed(found.caller);
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

  async function schemaProof() {
    await control(
      (caller) => owner.project(caller, "host.schema-ready", null),
      "schema",
    );
  }
  async function resumeProof() {
    await control(
      (caller) => owner.project(caller, OWNER_STARTUP_PROOF, null),
      "startup",
    );
  }
  try {
    // Explicit fresh provisioning may prepare tables, but NEVER establishes readiness.
    if (initialization === "fresh") {
      await provisionCopilotzSchema(session, schema);
      await provisionOperationCatalog(session, schema);
      await provisionOwnerCommandSchema(session, schema);
      await provisionOwnerAssignments(session, schema);
    } else {
      // Existing schemas are validated, never repaired or provisioned by resume.
      await validateSchemas(session);
      await validateCollectionIndexes(session, schema, collectionDefinitions);
    }
    await owner.acquire(
      initialization === "fresh" ? 0 : initialization.expectedEpoch,
    );
    if (initialization === "fresh") {
      await control(
        (caller) =>
          owner.execute(caller, {
            kind: "host.initialize-fresh",
            domain: "occurrence",
            key: freshKey,
            intent: null,
          }),
        "fresh",
      );
    } else {
      let proved = false;
      for (let pass = 0; pass < (initialization.maxPasses ?? 4); pass++) {
        const occurrence = crypto.randomUUID();
        const repaired = await control((caller) =>
          owner.execute(caller, {
            kind: OWNER_STARTUP_REPAIR,
            domain: "occurrence",
            key: ownerStartupRepairKey(ownerId, owner.epoch!, occurrence),
            intent: { occurrence },
          }), "startup");
        const plan = repaired.result as {
          blockers: unknown[];
          settlements: OperationSettlementScope[];
          terminalTargets?: OwnerHostTerminalRecoveryTarget[];
        };
        if (terminal && plan.terminalTargets?.length) {
          // Exact configured targets only. Each successful command is durable
          // progress, never readiness; the next full scan accounts for all of it.
          for (const target of plan.terminalTargets) {
            await terminal.recover(owner, target);
          }
          continue;
        }
        if (plan.blockers.length) {
          unavailable("Owner resume has unresolved durable startup blockers.");
        }
        for (const target of plan.settlements) {
          await control(
            (caller) =>
              settlement.run({
                boundary: owner,
                caller,
                target,
                occurrence: crypto.randomUUID(),
                signal: abort.signal,
              }),
            "startup-settlement",
            target,
          );
        }
        if (plan.settlements.length) continue;
        await resumeProof();
        proved = true;
        break;
      }
      if (!proved) {
        unavailable("Owner resume exceeded its bounded startup passes.");
      }
    }
    await schemaProof();
    transport = createTransport({
      ...transportOptions,
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
    // Transport callbacks remain denied until a second committed current proof.
    await schemaProof();
    if (initialization !== "fresh") await resumeProof();
    if (owner.state !== "acquired" || abort.signal.aborted || closed) {
      unavailable();
    }
    if (localBundle) {
      localControlToken = crypto.randomUUID();
      controlTokens.set(localControlToken, { purpose: "local-start" });
      const shared = {
        snapshots,
        registry,
        schema,
        boundary: owner,
        controlCaller: {
          principal: {
            kind: "owner-control" as const,
            ownerId,
            epoch: owner.epoch!,
            holderId,
          },
          ownerEpoch: owner.epoch!,
          hostControl: localControlToken,
        },
        maxActive,
        contexts: commandContexts,
        isCurrent: ready,
        assertControl(caller: OwnerCaller) {
          if (!ready()) unavailable();
          assertControl(caller, "local-start");
        },
        onIndeterminate: stop,
      };
      if (localConfiguration) {
        local = createOwnerHostLocalActions({
          ...shared,
          configuration: localConfiguration,
          capacity: {
            reserve(binding) {
              const scheduled = pending.get(binding.deliveryId);
              if (
                !scheduled || "kind" in scheduled ||
                scheduled.namespace !== binding.namespace ||
                scheduled.sourceEventId !== binding.sourceEventId ||
                scheduled.actionId !== binding.actionId ||
                scheduled.executionId !== binding.actionRunId
              ) return undefined;
              return reserveActive(binding.deliveryId, "owner-local");
            },
          },
        });
      }
      if (processorConfiguration) {
        localProcessor = createOwnerHostLocalProcessors({
          ...shared,
          configuration: processorConfiguration,
          capacity: {
            reserve(binding) {
              const scheduled = pending.get(binding.deliveryId);
              if (
                !scheduled || !("kind" in scheduled) ||
                scheduled.namespace !== binding.namespace ||
                scheduled.sourceEventId !== binding.sourceEventId ||
                scheduled.processorId !== binding.processorId
              ) return undefined;
              return reserveActive(binding.deliveryId, "owner-local");
            },
          },
          requestWake() {
            if (ready()) void wakeAlarms().catch(report);
          },
        });
      }
    }
    initialized = true;
    armAlarm();
  } catch (error) {
    stop(error);
    try {
      await transport?.shutdown("owner initialization failed");
    } catch (cleanupError) {
      report(cleanupError);
    }
    throw error;
  }
  return {
    /** Authority is already revoked when this resolves; close() owns cleanup.
     * Never expose the private enforcement AbortSignal to observers. */
    stopped,
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
    close(reason = "owner host closed"): Promise<void> {
      if (closing) return closing;
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      // Publish before revocation can synchronously reenter close through an
      // exposed abort listener. Every caller observes this same actual drain.
      closing = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      const cleanup = (async () => {
        closed = true;
        initialized = false;
        clearTimeout(alarmTimer);
        local?.stop(new Error(reason));
        localProcessor?.stop(new Error(reason));
        if (localControlToken) controlTokens.delete(localControlToken);
        abort.abort(new Error(reason));
        bridge.stop();
        notifyStopped();
        // Transport cleanup may fail independently of actual local/raw work.
        // Keep waiting for that work, and preserve the original shutdown error.
        const cleanup = await Promise.allSettled([
          Promise.resolve().then(() => snapshots?.stop()),
          Promise.resolve().then(() => transport!.shutdown(reason)),
          (async () => {
            await Promise.allSettled([...runningTasks]);
            await settlementPump;
            await alarmPass?.catch(() => undefined);
            await bridge.retryRetirements();
          })(),
        ]);
        owner.stop(reason);
        for (const result of cleanup) {
          if (result.status === "rejected") throw result.reason;
        }
      })();
      cleanup.then(resolve, reject);
      return closing;
    },
  };
}
