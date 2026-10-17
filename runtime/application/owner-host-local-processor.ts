/** Private same-owner local Processor composition. Host wiring owns scheduling,
 * SQL due-time eligibility and durable retry alarms. No public placement API. */
import { createOperationCatalogTables } from "../streams/catalog.ts";
import type { SqlExecutor } from "../events/session.ts";
import type { DurableEvent, EventDelivery } from "../events/types.ts";
import {
  createCoreTableNames,
  quoteEventIdentifier,
} from "../events/schema.ts";
import { assertJsonValue } from "../json.ts";
import type { PluginRegistry } from "../plugins/registry.ts";
import {
  createRegisteredLocalProcessorExecution,
  type RegisteredLocalProcessorOptions,
} from "../execution/registered-local-processor.ts";
import {
  createOwnerAssignmentControl,
  OWNER_ASSIGNMENT_BINDING_MAX_BYTES,
  ownerAssignmentKey,
  parseOwnerStoredAssignment,
} from "../owner/assignments.ts";
import type { OwnerLocalProcessorAssignmentBinding } from "../owner/placement-binding.ts";
import type {
  OwnerCaller,
  OwnerCommandBoundary,
  OwnerCommandContext,
  OwnerJson,
} from "../owner/boundary.ts";
import type {
  OwnerCollectionIntent,
  OwnerCollectionScope,
} from "../owner/collections.ts";
import {
  type OwnerLocalProcessorAssignment,
  ownerLocalProcessorCompletionKey,
  type OwnerLocalProcessorStartFacts,
  ownerLocalProcessorStartKey,
} from "../owner/processor.ts";
import { createOwnerLocalProcessorPort } from "../owner/local-processor-port.ts";
import {
  createOwnerLocalProcessorPlacementController,
  type OwnerLocalProcessorNullLeaseEvidence,
  type OwnerLocalProcessorPlacementEntry,
} from "./owner-local-processor-placement.ts";
import type { createOwnerHostCommandContexts } from "./owner-host-local.ts";
import type { OwnerScheduledAssignment } from "./owner-dispatch.ts";
import { ownConfiguration } from "./owner-local-configuration.ts";

type Binding = OwnerLocalProcessorAssignmentBinding;
type Grant = Readonly<{ ctx: boolean; settlement: boolean }>;
export type OwnerHostLocalProcessorOptions = Readonly<{
  processorIds: readonly string[];
  policy: Readonly<{
    grants(
      tx: SqlExecutor,
      authority: Readonly<
        {
          placement: "owner-local";
          phase: "start" | "current";
          binding: Binding;
        }
      >,
      time: string,
    ): Grant | undefined | Promise<Grant | undefined>;
    event(
      tx: SqlExecutor,
      assignment: OwnerLocalProcessorAssignment,
      event: DurableEvent,
      data: OwnerJson,
      time: string,
    ): void | Promise<void>;
    collections(
      tx: SqlExecutor,
      assignment: OwnerLocalProcessorAssignment,
      intent: OwnerCollectionIntent,
      time: string,
    ):
      | Pick<OwnerCollectionScope, "conditions">
      | Promise<Pick<OwnerCollectionScope, "conditions">>;
  }>;
  createCapabilities: RegisteredLocalProcessorOptions["createCapabilities"];
  maxEntries?: number;
  maxPendingCalls?: number;
  childWaitMs?: number;
}>;
function refuse(
  message = "Current local Processor host authority is unavailable.",
): never {
  throw Object.assign(new Error(message), {
    code: "owner_host_local_processor_unavailable",
  });
}
function copy<T>(value: T): T {
  assertJsonValue(value, {
    maxDepth: 64,
    maxNodes: 100_000,
    rejectNegativeZero: true,
  });
  return structuredClone(value);
}
function exact(a: unknown, b: unknown): boolean {
  const canonical = (value: unknown) =>
    JSON.stringify(
      copy(value),
      (_, item) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? Object.fromEntries(
            Object.keys(item).sort().map((k) => [k, item[k]]),
          )
          : item,
    );
  return canonical(a) === canonical(b);
}
export function captureOwnerHostLocalProcessors(
  supplied: OwnerHostLocalProcessorOptions,
  registry: PluginRegistry,
) {
  const input = ownConfiguration(supplied, [
    "processorIds",
    "policy",
    "createCapabilities",
  ], ["maxEntries", "maxPendingCalls", "childWaitMs"]);
  const policy = ownConfiguration(input.policy, [
    "grants",
    "event",
    "collections",
  ]);
  if (
    !Array.isArray(input.processorIds) ||
    Object.getPrototypeOf(input.processorIds) !== Array.prototype ||
    !input.processorIds.length || input.processorIds.length > 4096 ||
    [policy.grants, policy.event, policy.collections, input.createCapabilities]
      .some((f) => typeof f !== "function")
  ) throw new TypeError("Invalid private local Processor configuration.");
  const ids = copy(input.processorIds);
  const registered = new Set(
    Object.values(registry.processors).map((p) => p.id),
  );
  if (
    ids.some((id) =>
      typeof id !== "string" || !id || id !== id.trim() || id.length > 1024 ||
      !registered.has(id)
    ) || new Set(ids).size !== ids.length
  ) {
    throw new TypeError(
      "Local selection requires distinct registered Processor IDs.",
    );
  }
  const maxEntries = Object.hasOwn(input, "maxEntries")
    ? input.maxEntries
    : 4096;
  const maxPendingCalls = Object.hasOwn(input, "maxPendingCalls")
    ? input.maxPendingCalls
    : 32;
  if (
    typeof maxEntries !== "number" || !Number.isSafeInteger(maxEntries) ||
    maxEntries < 1 || maxEntries > 4096 ||
    typeof maxPendingCalls !== "number" ||
    !Number.isSafeInteger(maxPendingCalls) || maxPendingCalls < 1 ||
    maxPendingCalls > 128
  ) throw new TypeError("Invalid private local Processor capacity.");
  const childWaitMs = Object.hasOwn(input, "childWaitMs")
    ? input.childWaitMs
    : 30_000;
  if (
    typeof childWaitMs !== "number" || !Number.isSafeInteger(childWaitMs) ||
    childWaitMs < 1 || childWaitMs > 60_000
  ) {
    throw new TypeError(
      "Local child waits require a bound between 1 and 60000 milliseconds.",
    );
  }
  const selected = new Set(ids);
  return {
    selects: (id: string) => selected.has(id),
    policy: policy as OwnerHostLocalProcessorOptions["policy"],
    createCapabilities: input
      .createCapabilities as OwnerHostLocalProcessorOptions[
        "createCapabilities"
      ],
    maxEntries,
    maxPendingCalls,
    childWaitMs,
  };
}
export function createOwnerHostLocalProcessors(
  options: Readonly<{
    configuration: ReturnType<typeof captureOwnerHostLocalProcessors>;
    registry: PluginRegistry;
    schema: string;
    boundary: Pick<
      OwnerCommandBoundary,
      "execute" | "executeInput" | "project"
    >;
    controlCaller: OwnerCaller;
    maxActive: number;
    capacity: Readonly<
      { reserve(binding: Binding): Readonly<{ release(): void }> | undefined }
    >;
    contexts: ReturnType<typeof createOwnerHostCommandContexts>;
    isCurrent(): boolean;
    assertControl(caller: OwnerCaller): void;
    onIndeterminate(error: unknown): void;
    /** Only requests a durable scan. Must not infer eligibility from this hint. */
    requestWake(): void;
  }>,
) {
  const {
    registry,
    schema,
    maxActive,
    isCurrent,
    assertControl,
    onIndeterminate,
    requestWake,
  } = options;
  const {
    selects,
    createCapabilities,
    maxPendingCalls,
    maxEntries,
    childWaitMs,
  } = options.configuration;
  const policy = { ...options.configuration.policy };
  const controlCaller = copy(options.controlCaller),
    p = controlCaller.principal;
  if (p.kind !== "owner-control") refuse();
  const { ownerId, epoch, holderId } = p;
  const executeInput = options.boundary.executeInput.bind(options.boundary);
  const execute = options.boundary.execute.bind(options.boundary),
    project = options.boundary.project.bind(options.boundary);
  const operationTables = createOperationCatalogTables(schema);
  const tables = createCoreTableNames(schema),
    assignmentTable = `${quoteEventIdentifier(schema)}."owner_assignments"`;
  const authorizeAlarmContext = options.contexts.isCurrent;
  const controller = createOwnerLocalProcessorPlacementController({
    controlCaller,
    boundary: { execute },
    isCurrent,
    capacity: options.capacity,
    maxEntries,
    authorizeAlarmContext,
    async predecessorRetired(tx, binding) {
      const rows = (await tx.query(
        `SELECT owner,epoch,assignment_key,delivery_id,retired,CASE WHEN octet_length(binding::text)<=${OWNER_ASSIGNMENT_BINDING_MAX_BYTES} THEN binding ELSE '{}'::jsonb END AS binding FROM ${assignmentTable} WHERE owner=$1 AND epoch=$2 AND assignment_key=$3 AND delivery_id=$4 FOR UPDATE`,
        [
          ownerId,
          epoch,
          ownerAssignmentKey(ownerId, binding),
          binding.deliveryId,
        ],
      )).rows;
      if (rows.length !== 1) return false;
      const stored = parseOwnerStoredAssignment(rows[0]);
      return stored.owner === ownerId && stored.epoch === epoch &&
        stored.retired && exact(stored.binding, binding);
    },
  });
  const assignments = createOwnerAssignmentControl({
    ownerId,
    schema,
    maxActive,
    authorizeControl: (_tx, caller) => assertControl(caller),
    isCurrentStarted: () => false,
    resolveCurrentLocal: (caller) =>
      controller.resolveCurrent(caller)?.reference,
    hasProcessor: selects,
  });
  const startProofs = new WeakMap<
    SqlExecutor,
    {
      caller: OwnerCaller;
      binding: Binding;
      facts: OwnerLocalProcessorStartFacts;
      time: string;
      ordinal: number;
    }
  >();
  const latest = new Map<string, OwnerLocalProcessorPlacementEntry>();
  let stopped = false;
  const stop = (reason?: unknown) => {
    stopped = true;
    controller.stop(reason);
  };
  async function grants(
    tx: SqlExecutor,
    binding: Binding,
    phase: "start" | "current",
    time: string,
  ) {
    const returned = policy.grants(
      tx,
      copy({ placement: "owner-local", binding, phase }),
      time,
    );
    const result = returned instanceof Promise ? await returned : returned;
    return result === undefined ? undefined : copy(result);
  }
  async function authorizeStart(
    tx: SqlExecutor,
    caller: OwnerCaller,
    binding: Binding,
    facts: OwnerLocalProcessorStartFacts,
    time: string,
  ) {
    startProofs.delete(tx);
    assertControl(caller);
    if (!selects(binding.processorId)) return undefined;
    const grant = await controller.authorizeStart(
      tx,
      caller,
      binding,
      facts,
      time,
    );
    if (!grant) return undefined;
    const permission = await grants(tx, binding, "start", time);
    assertControl(caller);
    if (
      permission?.ctx !== true ||
      !controller.isCurrent(caller, binding, grant.attemptOrdinal, "start")
    ) return undefined;
    startProofs.set(tx, {
      caller: copy(caller),
      binding: copy(binding),
      facts: copy(facts),
      time,
      ordinal: grant.attemptOrdinal,
    });
    return grant;
  }
  async function resolve(
    tx: SqlExecutor,
    caller: OwnerCaller,
    time: string,
  ): Promise<OwnerLocalProcessorAssignment | undefined> {
    const binding = await assignments.resolveLocal(tx, caller);
    if (
      !binding || binding.kind !== "processor" || !selects(binding.processorId)
    ) return undefined;
    const permission = await grants(tx, binding, "current", time);
    const again = await assignments.resolveLocal(tx, caller),
      privateEntry = controller.resolveCurrent(caller);
    if (
      !permission || !again || !privateEntry || !exact(binding, again) ||
      !exact(binding, privateEntry.reference)
    ) return undefined;
    return {
      ...binding,
      attemptOrdinal: privateEntry.attemptOrdinal,
      ctxGranted: permission.ctx === true,
      settlementGranted: permission.settlement === true,
    };
  }
  return {
    selects,
    stop,
    current: controller.resolveCurrent,
    resolve,
    processor: {
      authorizeStart,
      isCurrent: controller.isCurrent,
      async reserveLocal(context: OwnerCommandContext, binding: Binding) {
        const proof = startProofs.get(context.tx);
        startProofs.delete(context.tx);
        if (
          !proof || !authorizeAlarmContext(context) ||
          proof.time !== context.commandTime ||
          !exact(proof.caller, context.caller) || !exact(proof.binding, binding)
        ) refuse();
        // Policy callbacks joined this transaction after the initial proof.
        // Re-read the predecessor after them; a row lock does not protect us
        // from mutations made by our own transaction.
        const grant = await controller.authorizeStart(
          context.tx,
          context.caller,
          binding,
          proof.facts,
          context.commandTime,
        );
        if (
          grant?.attemptOrdinal !== proof.ordinal ||
          !authorizeAlarmContext(context)
        ) refuse();
        await assignments.reserveLocal(context, binding);
      },
      retireLocal: assignments.retireLocal,
    },
    event: (
      tx: SqlExecutor,
      assignment: OwnerLocalProcessorAssignment,
      event: DurableEvent,
      data: OwnerJson,
      time: string,
    ) => policy.event(tx, copy(assignment), copy(event), copy(data), time),
    async collections(
      tx: SqlExecutor,
      assignment: OwnerLocalProcessorAssignment,
      intent: OwnerCollectionIntent,
      time: string,
    ) {
      const returned = policy.collections(
        tx,
        copy(assignment),
        copy(intent),
        time,
      );
      return copy(returned instanceof Promise ? await returned : returned);
    },
    async retryNamespace(
      context: OwnerCommandContext,
      suppliedDelivery: EventDelivery,
    ): Promise<string> {
      const delivery = copy(suppliedDelivery);
      if (
        !authorizeAlarmContext(context) ||
        context.command.kind !== "processor.local-complete" ||
        context.command.domain !== "incarnation"
      ) refuse();
      const current = controller.resolveCurrent(context.caller);
      if (
        !current || current.reference.deliveryId !== delivery.id ||
        current.attemptOrdinal !== delivery.attempts ||
        current.reference.sourceEventId !== delivery.eventId ||
        current.reference.consumerId !== delivery.consumerId
      ) refuse();
      const binding = current.reference;
      if (context.command.key !== ownerLocalProcessorCompletionKey(binding)) {
        refuse();
      }
      const permission = await grants(
        context.tx,
        binding,
        "current",
        context.commandTime,
      );
      if (
        permission?.settlement !== true || !authorizeAlarmContext(context) ||
        !controller.isCurrent(
          context.caller,
          binding,
          current.attemptOrdinal,
          "settlement",
        )
      ) refuse();
      const rows = (await context.tx.query(
        `SELECT a.owner,a.epoch,a.assignment_key,a.delivery_id,a.retired,
        CASE WHEN octet_length(a.binding::text)<=${OWNER_ASSIGNMENT_BINDING_MAX_BYTES} THEN a.binding ELSE '{}'::jsonb END AS binding,
        d.status,d.attempts,d.max_attempts,d.available_at::text AS available_at,d.lease_owner,d.lease_expires_at,d.event_id,d.consumer_id,d.settlement_scope_id,d.action_scope_id,e.owner_id AS source_owner,e.namespace AS source_namespace,o.state AS operation_state,o.cancellation_requested_at
        FROM ${assignmentTable} a JOIN ${tables.event_deliveries} d ON d.id=a.delivery_id JOIN ${tables.events} e ON e.id=d.event_id
        JOIN ${operationTables.operations} o ON o.namespace=e.namespace AND o.operation_id=d.settlement_scope_id
        WHERE a.owner=$1 AND a.epoch=$2 AND a.assignment_key=$3 AND a.delivery_id=$4 FOR UPDATE OF a`,
        [ownerId, epoch, ownerAssignmentKey(ownerId, binding), delivery.id],
      )).rows;
      if (rows.length !== 1) refuse();
      const row = rows[0], stored = parseOwnerStoredAssignment(row);
      if (
        stored.owner !== ownerId || stored.epoch !== epoch || !stored.retired ||
        !exact(stored.binding, binding) || row.status !== "retry_wait" ||
        row.attempts !== current.attemptOrdinal ||
        row.event_id !== binding.sourceEventId ||
        row.consumer_id !== binding.consumerId ||
        row.source_owner !== ownerId ||
        row.source_namespace !== binding.namespace ||
        row.settlement_scope_id !== delivery.settlementScopeId ||
        row.action_scope_id !== (delivery.actionScopeId ?? null) ||
        row.max_attempts !== delivery.maxAttempts ||
        !["accepted", "running"].includes(String(row.operation_state)) ||
        row.cancellation_requested_at !== null ||
        row.available_at !== delivery.availableAt || row.lease_owner !== null ||
        row.lease_expires_at !== null || !authorizeAlarmContext(context) ||
        !controller.isCurrent(
          context.caller,
          binding,
          current.attemptOrdinal,
          "settlement",
        )
      ) refuse();
      return binding.namespace;
    },
    async run(scheduled: OwnerScheduledAssignment): Promise<void> {
      if (
        !("kind" in scheduled) || scheduled.kind !== "processor" ||
        !selects(scheduled.processorId)
      ) refuse("Local Processor was not selected.");
      const binding: Binding = {
        placement: "owner-local",
        kind: "processor",
        ownerId,
        epoch,
        holderId,
        namespace: scheduled.namespace,
        sourceEventId: scheduled.sourceEventId,
        deliveryId: scheduled.deliveryId,
        processorId: scheduled.processorId,
        consumerId: `processor:${scheduled.processorId}`,
        attemptId: crypto.randomUUID(),
      };
      const entry = controller.reserve(
        binding,
        ownerLocalProcessorStartKey(binding),
      );
      latest.set(binding.deliveryId, entry);
      // An unresolved unknown-outcome hint must never block shutdown.
      void entry.released.then(() => {
        if (
          stopped || latest.get(binding.deliveryId) !== entry ||
          isCurrent() !== true
        ) return;
        if (stopped || latest.get(binding.deliveryId) !== entry) return;
        requestWake();
      }).catch((error) => {
        stop(error);
        onIndeterminate(error);
      });
      const port = createOwnerLocalProcessorPort({
        boundary: {
          execute: (caller, command, callOptions) =>
            command.kind === "owner.local-processor-start"
              ? entry.executeStart(caller, command, callOptions)
              : execute(caller, command, callOptions),
          project,
          executeInput,
        },
        reference: entry.reference,
        attemptOrdinal: entry.attemptOrdinal,
        controlCaller: entry.controlCaller,
        localCaller: entry.localCaller,
        isCurrent: entry.isCurrent,
        onStarted: entry.onStarted,
        onEnded: entry.onEnded,
        maxPendingCalls,
        children: { registry, maxWaitMs: childWaitMs },
      });
      const driver = createRegisteredLocalProcessorExecution({
        registry,
        reference: entry.reference,
        attemptOrdinal: entry.attemptOrdinal,
        owner: port,
        createCapabilities,
        isCurrent: entry.isCurrent,
        onIndeterminate(error) {
          entry.quarantine(error);
          stop(error);
          onIndeterminate(error);
        },
      });
      entry.attachDriver(driver);
      await driver.run();
    },
    async classifyNullLease(
      context: OwnerCommandContext,
      deliveryId: string,
    ): Promise<"pending-start" | "running" | undefined> {
      if (!authorizeAlarmContext(context)) return undefined;
      const rows = (await context.tx.query(
        `SELECT a.owner,a.epoch,a.assignment_key,a.delivery_id,a.retired,
        CASE WHEN octet_length(a.binding::text)<=${OWNER_ASSIGNMENT_BINDING_MAX_BYTES} THEN a.binding ELSE '{}'::jsonb END AS binding,
        d.id,d.event_id,d.consumer_id,d.status,d.attempts,d.lease_owner,d.lease_expires_at,e.owner_id AS source_owner,e.namespace
        FROM ${assignmentTable} a JOIN ${tables.event_deliveries} d ON d.id=a.delivery_id JOIN ${tables.events} e ON e.id=d.event_id
        WHERE a.owner=$1 AND a.delivery_id=$2 AND a.retired=FALSE FOR SHARE OF a`,
        [ownerId, deliveryId],
      )).rows;
      if (rows.length !== 1 || !authorizeAlarmContext(context)) {
        return undefined;
      }
      const row = rows[0],
        stored = parseOwnerStoredAssignment(row),
        binding = stored.binding;
      if (
        binding.placement !== "owner-local" || binding.kind !== "processor" ||
        row.source_owner !== ownerId || !selects(binding.processorId)
      ) return undefined;
      return controller.classifyNullLease(context, {
        assignment: {
          owner: stored.owner,
          epoch: stored.epoch,
          binding,
          retired: stored.retired,
        },
        delivery: {
          id: row.id,
          eventId: row.event_id,
          consumerId: row.consumer_id,
          status: row.status,
          attempts: row.attempts,
          leaseOwner: row.lease_owner,
          leaseExpiresAt: row.lease_expires_at,
        },
        source: {
          id: row.event_id,
          namespace: row.namespace,
          processorId: binding.processorId,
        },
      } as OwnerLocalProcessorNullLeaseEvidence);
    },
  };
}
