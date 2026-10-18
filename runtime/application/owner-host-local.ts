import type { RegisteredStreamPort } from "../execution/stream-capability.ts";
import type { LocalSnapshotResources } from "../owner/local-snapshot-port.ts";
import type { OwnerAuthorityReadMode } from "../owner/authority-read.ts";
import { ownConfiguration } from "./owner-local-configuration.ts";
/** Private fresh-only local Action composition. No public placement option,
 * worker identity or restart adoption. Effects and named preparation reuse the
 * shared owner protocols and policies with the exact local attempt. */
import type { SqlExecutor } from "../events/session.ts";
import { createCoreTableNames } from "../events/schema.ts";
import { assertJsonValue } from "../json.ts";
import type { PluginRegistry } from "../plugins/registry.ts";
import {
  createRegisteredLocalActionExecution,
  type RegisteredLocalActionOptions,
} from "../execution/registered-local.ts";
import { createOwnerAssignmentControl } from "../owner/assignments.ts";
import type { OwnerLocalActionAssignmentBinding } from "../owner/placement-binding.ts";
import type {
  OwnerCaller,
  OwnerCommand,
  OwnerCommandBoundary,
  OwnerCommandContext,
  OwnerJson,
} from "../owner/boundary.ts";
import type {
  OwnerCollectionIntent,
  OwnerCollectionScope,
} from "../owner/collections.ts";
import {
  ownerLocalActionStartKey,
  type OwnerLocalExecutionAssignment,
} from "../owner/execution.ts";
import { createOwnerLocalActionPort } from "../owner/local-action-port.ts";
import {
  createOwnerLocalPlacementController,
} from "./owner-local-placement.ts";
import type { OwnerScheduledAssignment } from "./owner-dispatch.ts";

type Binding = OwnerLocalActionAssignmentBinding;
type Grant = Readonly<{ ctx: boolean; settlement: boolean }>;
export type OwnerHostLocalActionAuthority = Readonly<{
  placement: "owner-local";
  phase: "start" | "current";
  binding: Binding;
}>;
export type OwnerHostLocalActionOptions = Readonly<{
  /** Stable registered Action IDs selected only by trusted owner composition. */
  actionIds: readonly string[];
  policy: Readonly<{
    grants(
      tx: SqlExecutor,
      authority: OwnerHostLocalActionAuthority,
      time: string,
    ): Grant | undefined | Promise<Grant | undefined>;
    input(
      tx: SqlExecutor,
      assignment: OwnerLocalExecutionAssignment,
      value: OwnerJson,
      time: string,
    ): void | Promise<void>;
    collections(
      tx: SqlExecutor,
      assignment: OwnerLocalExecutionAssignment,
      intent: OwnerCollectionIntent,
      time: string,
    ):
      | Pick<OwnerCollectionScope, "conditions">
      | Promise<Pick<OwnerCollectionScope, "conditions">>;
  }>;
  createCapabilities: RegisteredLocalActionOptions["createCapabilities"];
  maxEntries?: number;
  maxPendingCalls?: number;
  childWaitMs?: number;
}>;
function refuse(
  message = "Current local host authority is unavailable.",
): never {
  throw Object.assign(new Error(message), {
    code: "owner_host_local_unavailable",
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
  const canonical = (value: unknown): string =>
    JSON.stringify(
      value,
      (_, item) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? Object.fromEntries(
            Object.keys(item).sort().map((key) => [key, item[key]]),
          )
          : item,
    );
  return canonical(copy(a)) === canonical(copy(b));
}
function text(value: unknown): asserts value is string {
  if (
    typeof value !== "string" || !value.trim() || value !== value.trim() ||
    value.length > 1024
  ) refuse("Invalid local host identifier.");
}
/** Capture configuration before the host's first provisioning/initialization await. */
export function captureOwnerHostLocalActions(
  supplied: OwnerHostLocalActionOptions,
  registry: PluginRegistry,
) {
  const input = ownConfiguration(supplied, [
    "actionIds",
    "policy",
    "createCapabilities",
  ], ["maxEntries", "maxPendingCalls", "childWaitMs"]);
  const callbacks = ownConfiguration(input.policy, [
    "grants",
    "input",
    "collections",
  ]);
  if (
    !Array.isArray(input.actionIds) ||
    Object.getPrototypeOf(input.actionIds) !== Array.prototype ||
    !input.actionIds.length || input.actionIds.length > 4096 ||
    [
      callbacks.grants,
      callbacks.input,
      callbacks.collections,
      input.createCapabilities,
    ]
      .some((callback) => typeof callback !== "function")
  ) {
    throw new TypeError("Invalid private local Action configuration.");
  }
  const ids = copy(input.actionIds);
  const registered = new Set(
    Object.values(registry.actions).map((action) => action.id),
  );
  ids.forEach(text);
  if (
    new Set(ids).size !== ids.length || ids.some((id) => !registered.has(id))
  ) {
    throw new TypeError(
      "Local selection requires distinct registered Action IDs.",
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
  ) {
    throw new TypeError("Invalid private local Action capacity.");
  }
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
  const policy = callbacks as OwnerHostLocalActionOptions["policy"];
  const createCapabilities = input
    .createCapabilities as OwnerHostLocalActionOptions["createCapabilities"];
  return {
    selects: (id: string) => selected.has(id),
    policy,
    createCapabilities,
    maxEntries,
    maxPendingCalls,
    childWaitMs,
  };
}

/** The actual boundary's successful authorization is distinct from a matching
 * structural context. Only the exact currently executing wrapped handler is live. */
export function createOwnerHostCommandContexts(
  options: Readonly<{
    ownerId: string;
    holderId: string;
    epoch(): number | undefined;
    isCurrent(): boolean;
  }>,
) {
  const { ownerId, holderId, epoch, isCurrent } = options;
  const authorized = new WeakMap<
    SqlExecutor,
    Readonly<{
      caller: OwnerCaller;
      command: OwnerCommandContext["command"];
      time: string;
    }>
  >();
  const live = new WeakSet<OwnerCommandContext>();
  function matches(context: OwnerCommandContext): boolean {
    const found = authorized.get(context.tx);
    return !!found && isCurrent() === true && !context.signal.aborted &&
      context.ownerCommit.transaction === context.tx &&
      context.ownerCommit.ownerId === ownerId &&
      context.ownerCommit.holderId === holderId &&
      context.ownerCommit.epoch === epoch() &&
      context.ownerCommit.commandTime === context.commandTime &&
      found.time === context.commandTime &&
      exact(found.caller, context.caller) &&
      exact(found.command, context.command);
  }
  return {
    async authorize(
      tx: SqlExecutor,
      caller: OwnerCaller,
      command: OwnerCommand,
      time: string,
      run: () => void | Promise<void>,
    ): Promise<void> {
      authorized.delete(tx);
      const captured = copy({
        caller,
        command: {
          kind: command.kind,
          domain: command.domain,
          key: command.key,
        },
        time,
      });
      await run();
      authorized.set(tx, captured);
    },
    async run<T>(
      context: OwnerCommandContext,
      run: () => T | Promise<T>,
    ): Promise<T> {
      if (!matches(context) || live.has(context)) {
        refuse("Unauthenticated owner alarm command context.");
      }
      live.add(context);
      try {
        return await run();
      } finally {
        live.delete(context);
      }
    },
    isCurrent(context: OwnerCommandContext): boolean {
      return live.has(context) && matches(context);
    },
  };
}

export function createOwnerHostLocalActions(
  options: Readonly<{
    snapshots?: LocalSnapshotResources;
    streams?: (caller: OwnerCaller) => RegisteredStreamPort;
    configuration: ReturnType<typeof captureOwnerHostLocalActions>;
    registry: PluginRegistry;
    schema: string;
    boundary: Pick<
      OwnerCommandBoundary,
      "execute" | "executeInput" | "project"
    >;
    controlCaller: OwnerCaller;
    maxActive: number;
    capacity: Readonly<{
      reserve(binding: Binding): Readonly<{ release(): void }> | undefined;
    }>;
    isCurrent(): boolean;
    assertControl(caller: OwnerCaller): void;
    onIndeterminate(error: unknown): void;
  }>,
) {
  const snapshotResources = options.snapshots;
  const streamPort = options.streams;
  const {
    registry,
    schema,
    maxActive,
    isCurrent,
    assertControl,
    onIndeterminate,
  } = options;
  const configuration = options.configuration;
  const selects = configuration.selects;
  const policy = { ...configuration.policy };
  const createCapabilities = configuration.createCapabilities;
  const maxPendingCalls = configuration.maxPendingCalls;
  const childWaitMs = configuration.childWaitMs;
  const controlCaller = copy(options.controlCaller);
  const p = controlCaller.principal;
  if (p.kind !== "owner-control") refuse();
  const { ownerId, epoch, holderId } = p;
  const boundary = options.boundary;
  const rawExecute = boundary.execute.bind(boundary);
  const execute: typeof rawExecute = (caller, command, callOptions) => {
    snapshotResources?.assertOrdinaryAllowed(caller);
    return rawExecute(caller, command, callOptions);
  };
  const rawExecuteInput = boundary.executeInput.bind(boundary);
  const executeInput: typeof rawExecuteInput = (
    caller,
    command,
    callOptions,
  ) => {
    snapshotResources?.assertOrdinaryAllowed(caller);
    return rawExecuteInput(caller, command, callOptions);
  };
  const rawProject = boundary.project.bind(boundary);
  const project: typeof rawProject = (caller, kind, input, callOptions) => {
    snapshotResources?.assertOrdinaryAllowed(caller);
    return rawProject(caller, kind, input, callOptions);
  };
  const tables = createCoreTableNames(schema);
  const controller = createOwnerLocalPlacementController({
    controlCaller,
    boundary: { execute },
    isCurrent,
    capacity: options.capacity,
    maxEntries: configuration.maxEntries,
  });
  const assignments = createOwnerAssignmentControl({
    ownerId,
    schema,
    maxActive,
    authorizeControl: (_tx, caller) => assertControl(caller),
    isCurrentStarted: () => false,
    resolveCurrentLocal: controller.resolveCurrentLocal,
    hasAction: selects,
  });
  async function grants(
    tx: SqlExecutor,
    binding: Binding,
    phase: "start" | "current",
    time: string,
  ) {
    const returned = policy.grants(
      tx,
      copy({ placement: "owner-local", phase, binding }),
      time,
    );
    const value = returned instanceof Promise ? await returned : returned;
    return value === undefined ? undefined : copy(value);
  }
  async function authorizeStart(
    tx: SqlExecutor,
    caller: OwnerCaller,
    binding: Binding,
    time: string,
  ) {
    assertControl(caller);
    if (
      !selects(binding.actionId) ||
      !controller.authorizeStart(tx, caller, binding, time)
    ) return false;
    const permission = await grants(tx, binding, "start", time);
    assertControl(caller);
    return permission?.ctx === true &&
      controller.authorizeStart(tx, caller, binding, time);
  }
  async function resolve(
    tx: SqlExecutor,
    caller: OwnerCaller,
    time: string,
    readMode: OwnerAuthorityReadMode = "locking",
  ): Promise<OwnerLocalExecutionAssignment | undefined> {
    const binding = await assignments.resolveLocal(tx, caller, readMode);
    if (!binding || binding.kind !== "action" || !selects(binding.actionId)) {
      return undefined;
    }
    const permission = await grants(tx, binding, "current", time);
    const again = await assignments.resolveLocal(tx, caller, readMode);
    if (!permission || !again || !exact(binding, again)) return undefined;
    const source = (await tx.query<{
      id: string;
      namespace: string;
      metadata: Record<string, OwnerJson>;
      correlation_id: string;
      settlement_scope_id: string;
      action_scope_id: string | null;
      type: string;
      deduplication_id: string;
      consumer_id: string;
    }>(
      `SELECT e.id,e.namespace,e.metadata,e.correlation_id,e.type,e.deduplication_id,d.consumer_id,d.settlement_scope_id,d.action_scope_id FROM ${tables.events} e JOIN ${tables.event_deliveries} d ON d.event_id=e.id WHERE e.id=$1 AND e.owner_id=$2 AND d.id=$3`,
      [binding.sourceEventId, ownerId, binding.deliveryId],
    )).rows[0];
    const privateBinding = controller.resolveCurrentLocal(caller);
    if (
      !source || !privateBinding || !exact(binding, privateBinding) ||
      source.namespace !== binding.namespace ||
      source.type !== "copilotz.owner.action.requested" ||
      source.deduplication_id !== binding.actionRunId ||
      source.consumer_id !== `registered:${binding.actionId}` ||
      source.metadata.actionId !== binding.actionId ||
      source.metadata.actionRunId !== binding.actionRunId
    ) return undefined;
    const rootKey = source.metadata.rootKey ?? binding.actionRunId;
    text(rootKey);
    const parentActionRunId = source.metadata.parentActionRunId;
    if (parentActionRunId !== undefined) text(parentActionRunId);
    const metadata = copy(source.metadata.actionMetadata);
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      refuse();
    }
    return {
      ...binding,
      ctxGranted: permission.ctx === true,
      settlementGranted: permission.settlement === true,
      invocation: {
        actionRunId: binding.actionRunId,
        rootKey,
        operationKey: binding.actionRunId,
        ...(parentActionRunId ? { parentActionRunId } : {}),
        metadata: metadata as Readonly<Record<string, OwnerJson>>,
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
  return {
    selects,
    stop: controller.stop,
    current: controller.resolveCurrentLocal,
    captureLifetime: controller.captureCurrentLifetime,
    isInvocationCurrent: controller.isInvocationCurrent,
    captureReservedLifetime: controller.captureReservedLifetime,
    resolve,
    execution: {
      authorizeStart,
      reserveLocal: assignments.reserveLocal,
      retireLocal: assignments.retireLocal,
    },
    input: (
      tx: SqlExecutor,
      assignment: OwnerLocalExecutionAssignment,
      value: OwnerJson,
      time: string,
    ) => policy.input(tx, copy(assignment), copy(value), time),
    async collections(
      tx: SqlExecutor,
      assignment: OwnerLocalExecutionAssignment,
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
    async run(scheduled: OwnerScheduledAssignment): Promise<void> {
      if ("kind" in scheduled || !selects(scheduled.actionId)) {
        refuse("Local Action was not selected.");
      }
      const binding: Binding = {
        placement: "owner-local",
        kind: "action",
        ownerId,
        epoch,
        holderId,
        namespace: scheduled.namespace,
        sourceEventId: scheduled.sourceEventId,
        deliveryId: scheduled.deliveryId,
        actionId: scheduled.actionId,
        actionRunId: scheduled.executionId,
        attemptId: crypto.randomUUID(),
      };
      const entry = controller.reserve(
        binding,
        ownerLocalActionStartKey(binding),
      );
      const port = createOwnerLocalActionPort({
        snapshots: snapshotResources,
        streams: streamPort?.(entry.localCaller),
        boundary: {
          execute: (caller, command, callOptions) =>
            command.kind === "owner.local-start"
              ? entry.executeStart(caller, command, callOptions)
              : execute(caller, command, callOptions),
          executeInput,
          project,
        },
        reference: entry.reference,
        controlCaller: entry.controlCaller,
        localCaller: entry.localCaller,
        isCurrent: entry.isCurrent,
        onStarted: entry.onStarted,
        onTerminal: entry.onTerminal,
        maxPendingCalls,
        children: { registry, maxWaitMs: childWaitMs },
      });
      const driver = createRegisteredLocalActionExecution({
        registry,
        reference: entry.reference,
        owner: port,
        createCapabilities,
        isCurrent: entry.isCurrent,
        onIndeterminate(error) {
          entry.revoke(error);
          onIndeterminate(error);
        },
      });
      entry.attachDriver(driver);
      await driver.run();
    },
  };
}
