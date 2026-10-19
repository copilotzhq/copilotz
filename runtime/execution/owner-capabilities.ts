import { observeContentStreamFailure } from "../streams/stream.ts";
import { ActionOwnershipLost } from "../actions/ownership.ts";
import {
  withoutOwnerCommandAuthorization,
} from "../engine/command-authorization.ts";
import type {
  DeliveryAttemptRegistration,
  OwnerSessionAuthority,
  OwnerSessionSource,
} from "./types.ts";
import { ownerExecutionInterrupted } from "./owner-interruption.ts";
import { collectionReceiptInvocation } from "../collections/policy-invocation.ts";
import {
  capabilityReceiptIntent,
  withCollectionCommandReceipt,
} from "../collections/command-receipt.ts";
import { snapshotControl } from "../collections/snapshot-control.ts";
/** Owner-side capability admission. Worker code never imports this module. */
import type {
  HypervisorLifecycleCallbacks,
  WorkerCallContext,
  WorkerCallOptions,
} from "../../dependencies/oxian-hypervisor.ts";
import type {
  WorkerWorkContext,
  WorkerWorkResult,
} from "../../dependencies/oxian-worker.ts";
import type { PluginRegistry } from "../plugins/registry.ts";
import type { ProcessorContext } from "../plugins/processor.ts";
import type { ActionContext } from "../actions/types.ts";
import { protectedEventResolverFrom } from "../actions/protected-context.ts";
import type { OwnerExecutionFactory } from "./workload.ts";
import {
  type CapabilityCall,
  capabilityError,
  type CapabilityInvocation,
  type CapabilityPoll,
  encodeCapability,
  OWNER_CAPABILITY_BYTES,
  OWNER_CAPABILITY_WORKLOAD,
  readCapability,
} from "./owner-capability-wire.ts";

type Method = (...args: unknown[]) => unknown;
type RecordValue = Record<string, unknown>;
type Deferred<T> = ReturnType<typeof Promise.withResolvers<T>>;
const MAX_CONTEXTS = 256;
const MAX_RESOURCES = 32;
const MAX_ASSIGNMENTS = 256;
const POLL_MS = 10_000;
const RESOURCE_IDLE_MS = 30_000;
const RESOURCE_LIFETIME_MS = 120_000;

type Resource = {
  id: string;
  context: string;
  kind: "snapshot" | "writer" | "reader";
  value: RecordValue;
  serial: Promise<unknown>;
  created: number;
  used: number;
  closed: boolean;
  pendingAppends?: number;
  /** Body sealing does not revoke its bounded retention capability. */
  writerSealed?: boolean;
  removeFailure?(): void;
  close(reason?: unknown): Promise<void>;
  run?(path: readonly string[], args: readonly unknown[]): Promise<unknown>;
};
type ResourceReservation = {
  resource: Resource;
  ready: Deferred<Resource["close"] | undefined>;
  consumed: boolean;
};

type Invocation = {
  sealed: boolean;
  logicalAbort: boolean;
  semanticFailure: boolean;
  streamFailure?: { reason: unknown };
  failStream(reason: unknown): void;
  calls: Set<Promise<void>>;
  context: ProcessorContext | ActionContext;
  receiptPrincipal?: string;
  result: Deferred<unknown>;
  removeAbort(): void;
};
type Assignment = {
  key: string;
  binding: WorkerCallContext;
  abort: AbortController;
  contexts: Map<string, Invocation>;
  resources: Map<string, Resource>;
  queue: CapabilityPoll[];
  wake?: Deferred<void>;
  task: Promise<void>;
  terminal?: { result?: WorkerWorkResult; error?: unknown };
  snapshotOpen?: boolean;
  authority?: Readonly<{ epoch: number; signal: AbortSignal }>;
  interruption?: Error;
  semanticRetirement?: boolean;
  heartbeatSequence: number;
  attempt?: DeliveryAttemptRegistration;
};

function own(value: unknown, key: string): unknown {
  if (
    !value || (typeof value !== "object" && typeof value !== "function") ||
    !Object.hasOwn(value, key) ||
    ["__proto__", "prototype", "constructor"].includes(key)
  ) throw capabilityError("owner_capability_refused");
  const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
  if (!("value" in descriptor)) {
    throw capabilityError("owner_capability_refused");
  }
  return descriptor.value;
}
function callPath(
  root: unknown,
  path: readonly string[],
  args: readonly unknown[],
): unknown {
  if (!path.length || path.length > 4) {
    throw capabilityError("owner_capability_refused");
  }
  let parent = root;
  for (const segment of path.slice(0, -1)) parent = own(parent, segment);
  const method = own(parent, path.at(-1)!);
  if (typeof method !== "function") {
    throw capabilityError("owner_capability_refused");
  }
  return (method as Method).apply(parent, [...args]);
}
function scopeOf(context: ProcessorContext | ActionContext): RecordValue {
  const action = context as ActionContext;
  return {
    namespace: context.namespace,
    databaseSchema: context.databaseSchema,
    operationKey: context.operationKey,
    identity: context.identity,
    ...(action.action ? { action: action.action } : {}),
    now: context.now().toISOString(),
  };
}
function allowedPath(path: readonly string[], snapshot = false): boolean {
  const [root, method, leaf, nested] = path;
  if (root === "collections") {
    if (!method || path.length < 3) return false;
    if (leaf === "commands") return !snapshot && path.length === 4 && !!nested;
    if (leaf === "queries") return path.length === 4 && !!nested;
    if (leaf === "relations") return nested === "list" && path.length === 4;
    return path.length === 3 &&
      [
        "get",
        "list",
        "aggregate",
        "search",
        ...(!snapshot ? ["create", "update", "delete"] : []),
      ].includes(leaf);
  }
  if (snapshot) return false;
  if (root === "actions") {
    return path.length === 2 ||
      path.length === 3 && leaf === "prepare";
  }
  if (root === "vectors") return path.length === 2 && method === "search";
  if (root === "operations") return path.length === 2 && method === "start";
  if (root === "effect") {
    return path.length === 2 &&
      [
        "begin",
        "inspect",
        "confirm",
        "notStarted",
        "inventory",
      ].includes(
        method,
      );
  }
  if (root === "content") {
    return path.length === 2 &&
      [
        "authorize",
        "prepare",
        "capture",
        "openCapture",
        "materialize",
        "publish",
        "get",
        "getMany",
        "resolve",
        "resolveMany",
        "open",
      ].includes(method);
  }
  if (root === "streams") {
    return path.length === 2 && ["open", "follow"].includes(method);
  }
  return path.length === 1 && ["progress", "protectedEvent"].includes(root);
}

/** Capture the actual accepted-state observer before remote admission. */
export function captureOwnerSessionAuthority(
  source: OwnerSessionSource | undefined,
): OwnerSessionAuthority {
  const { subscribe, assertCurrent } = source ?? {};
  if (typeof subscribe !== "function" || typeof assertCurrent !== "function") {
    throw new TypeError(
      "Remote dispatcher requires its accepted session authority (subscribe and assertCurrent).",
    );
  }
  return {
    subscribe: subscribe.bind(source),
    assertCurrent: assertCurrent.bind(source),
  };
}

function sameSession(
  left: WorkerCallContext["fence"],
  right: WorkerCallContext["fence"],
): boolean {
  return left.connectionId === right.connectionId &&
    left.sessionGeneration === right.sessionGeneration &&
    left.identity.workerId === right.identity.workerId &&
    left.identity.attemptId === right.identity.attemptId &&
    left.identity.epoch === right.identity.epoch;
}

export type OwnerCapabilityHost = Readonly<{
  workerCalls: WorkerCallOptions;
  lifecycle: HypervisorLifecycleCallbacks;
  close(reason?: string): Promise<void>;
}>;

export function createOwnerCapabilityHost(
  options: Readonly<{
    registry: PluginRegistry;
    createWorkloads: OwnerExecutionFactory;
    localExecution?: boolean;
    sessions?: OwnerSessionSource;
    resolveAuthority(
      schema: string,
    ): Promise<Readonly<{ epoch: number; signal: AbortSignal }>>;
    lookupReceipt?(
      identity: WorkerCallContext["fence"]["identity"],
      input: unknown,
    ): Promise<unknown>;
    resourceIdleMs?: number;
    resourceLifetimeMs?: number;
    onDiagnostic?: import("./types.ts").DeliveryDiagnosticSink;
  }>,
): OwnerCapabilityHost {
  // Capture trusted registration synchronously. Later caller mutation must not
  // replace authority/receipt callbacks after admission has already begun.
  options = { ...options };
  const sessions = options.localExecution
    ? undefined
    : captureOwnerSessionAuthority(options.sessions);
  const assignments = new Map<string, Assignment>();
  const pendingHeartbeats = new Map<
    Assignment,
    {
      sequence: number;
      attempt: DeliveryAttemptRegistration;
    }
  >();
  let renewing: Promise<void> | undefined;
  let closed = false;
  const idleMs = options.resourceIdleMs ?? RESOURCE_IDLE_MS;
  const lifetimeMs = options.resourceLifetimeMs ?? RESOURCE_LIFETIME_MS;
  for (const duration of [idleMs, lifetimeMs]) {
    if (!Number.isSafeInteger(duration) || duration < 1) {
      throw new TypeError("Resource timeouts must be positive integers.");
    }
  }
  const keyOf = (binding: WorkerCallContext) =>
    `${binding.fence.connectionId}:${binding.fence.sessionGeneration}:${
      binding.parent!.streamId
    }`;
  const notify = (assignment: Assignment, event: CapabilityPoll) => {
    if (assignment.queue.length >= MAX_CONTEXTS) {
      throw capabilityError("owner_capacity");
    }
    assignment.queue.push(event);
    assignment.wake?.resolve();
  };
  const closeResource = async (
    assignment: Assignment,
    resource: Resource,
    reason?: unknown,
  ) => {
    if (resource.closed) {
      await resource.serial;
      return;
    }
    resource.closed = true;
    // Retain the slot until actual cleanup settles, even after revocation.
    // Revoke/cancel immediately: a pending follower read must not prevent its
    // own cancellation. Keep capacity until both the call and cleanup settle.
    const inFlight = resource.serial.catch(() => undefined);
    const cleanup = Promise.resolve().then(() => resource.close(reason));
    resource.serial = (async () => {
      // A rejected cleanup must not release capacity while physical I/O is
      // still settling. Unknown cleanup keeps its reserved slot below.
      const results = await Promise.allSettled([inFlight, cleanup]);
      const result = results[1];
      if (result.status === "rejected") throw result.reason;
    })();
    try {
      await resource.serial;
      assignment.resources.delete(resource.id);
    } catch (error) {
      if ((error as { code?: unknown })?.code !== "owner_cleanup_unknown") {
        assignment.resources.delete(resource.id);
      }
      throw error;
    } finally {
      resource.removeFailure?.();
      resource.removeFailure = undefined;
    }
  };
  const abortAssignment = (assignment: Assignment, reason: unknown) => {
    pendingHeartbeats.delete(assignment);
    if (!assignment.abort.signal.aborted) assignment.abort.abort(reason);
    for (const invocation of assignment.contexts.values()) {
      invocation.result.reject(reason);
    }
    for (const resource of assignment.resources.values()) {
      void closeResource(assignment, resource, reason).catch(() => undefined);
    }
    assignment.wake?.resolve();
  };
  const check = (assignment: Assignment) => {
    assignment.abort.signal.throwIfAborted();
    sessions?.assertCurrent(assignment.binding.fence);
    const authority = assignment.authority;
    if (
      !authority ||
      authority.epoch !== assignment.binding.parent!.metadata.ownerEpoch ||
      authority.signal.aborted
    ) {
      const error = capabilityError(
        "ActionOwnershipLost",
        "The assignment belongs to a retired owner epoch.",
      );
      abortAssignment(assignment, error);
      throw error;
    }
  };
  const drainHeartbeats = async () => {
    while (!closed && pendingHeartbeats.size) {
      const batch = [...pendingHeartbeats];
      pendingHeartbeats.clear();
      const groups = new Map<
        DeliveryAttemptRegistration["store"],
        typeof batch
      >();
      for (const entry of batch) {
        const [assignment, evidence] = entry;
        if (
          assignment.attempt !== evidence.attempt ||
          assignment.abort.signal.aborted || evidence.attempt.signal.aborted ||
          assignment.terminal
        ) continue;
        const group = groups.get(evidence.attempt.store) ?? [];
        group.push(entry);
        groups.set(evidence.attempt.store, group);
      }
      for (const [store, group] of groups) {
        try {
          const members = new Map(
            group.map((entry) => [entry[1].attempt.heartbeat.id, entry]),
          );
          const renewed = await store.heartbeatDeliveries(
            group.map(([, evidence]) => evidence.attempt.heartbeat),
            (heartbeat, epoch) => {
              const [assignment, evidence] = members.get(heartbeat.id)!;
              try {
                if (closed) return false;
                const current = sessions!.assertCurrent(
                  assignment.binding.fence,
                );
                return assignments.get(assignment.key) === assignment &&
                  assignment.attempt === evidence.attempt &&
                  !assignment.terminal &&
                  !assignment.abort.signal.aborted &&
                  !evidence.attempt.signal.aborted &&
                  current.nextHeartbeatSequence >= evidence.sequence &&
                  epoch === heartbeat.ownerEpoch;
              } catch {
                return false;
              }
            },
          );
          const accepted = new Set(
            renewed.map(({ id, owner }) => JSON.stringify([id, owner])),
          );
          for (const [, evidence] of group) {
            if (
              !accepted.has(
                JSON.stringify([
                  evidence.attempt.heartbeat.id,
                  evidence.attempt.heartbeat.owner,
                ]),
              )
            ) {
              evidence.attempt.revoke(
                new ActionOwnershipLost(evidence.attempt.heartbeat.id),
              );
            }
          }
        } catch (error) {
          for (const [, evidence] of group) {
            evidence.attempt.revoke(
              error instanceof Error ? error : new Error(String(error)),
            );
          }
        }
      }
    }
  };
  const scheduleHeartbeats = () => {
    if (closed || renewing || !pendingHeartbeats.size) return;
    renewing = Promise.resolve().then(drainHeartbeats).catch((error) => {
      for (const assignment of assignments.values()) {
        abortAssignment(assignment, error);
      }
    }).finally(() => {
      renewing = undefined;
      scheduleHeartbeats();
    });
  };
  // Registry observers run only after sequence acceptance. They must neither
  // mutate the registry nor await I/O inside its synchronous notification.
  const unsubscribe = sessions?.subscribe((session) => {
    if (closed || !["ready", "draining"].includes(session.phase)) return;
    for (const assignment of assignments.values()) {
      if (
        !sameSession(session, assignment.binding.fence) ||
        session.nextHeartbeatSequence <= assignment.heartbeatSequence
      ) continue;
      assignment.heartbeatSequence = session.nextHeartbeatSequence;
      if (
        assignment.attempt && !assignment.abort.signal.aborted &&
        !assignment.attempt.signal.aborted && !assignment.terminal
      ) {
        pendingHeartbeats.set(assignment, {
          sequence: session.nextHeartbeatSequence,
          attempt: assignment.attempt,
        });
      }
    }
    scheduleHeartbeats();
  });
  if (sessions && typeof unsubscribe !== "function") {
    throw new TypeError(
      "Session subscription must return an unsubscribe function.",
    );
  }
  const timer = setInterval(() => {
    const now = Date.now();
    for (const assignment of assignments.values()) {
      for (const resource of assignment.resources.values()) {
        if (
          resource.kind !== "writer" && !resource.closed &&
          (now - resource.used >= idleMs ||
            now - resource.created >= lifetimeMs)
        ) {
          const error = capabilityError("owner_handle_expired");
          void closeResource(assignment, resource, error).catch(() =>
            undefined
          );
          // Expiry fails the execution, including a callback that caught a read failure.
          abortAssignment(assignment, error);
        }
      }
    }
  }, Math.min(1000, idleMs, lifetimeMs));
  (timer as unknown as { unref?: () => void }).unref?.();

  const invoke = async (
    assignment: Assignment,
    kind: CapabilityInvocation["kind"],
    alias: string,
    args: readonly unknown[],
    context: ProcessorContext | ActionContext,
  ): Promise<unknown> => {
    check(assignment);
    if (assignment.contexts.size >= MAX_CONTEXTS) {
      throw capabilityError("owner_capacity");
    }
    const id = crypto.randomUUID();
    const result = Promise.withResolvers<unknown>();
    void result.promise.catch(() => undefined);
    const stop = (reason: unknown) => {
      invocationState.sealed = true;
      result.reject(reason);
      for (const resource of assignment.resources.values()) {
        if (resource.context === id) {
          void closeResource(assignment, resource, reason).catch(
            () => undefined,
          );
        }
      }
      if (assignment.queue.length < MAX_CONTEXTS) {
        notify(assignment, { aborted: id });
      } else abortAssignment(assignment, capabilityError("owner_capacity"));
    };
    const abort = () => {
      // A caller cancellation predating placement revocation stays semantic.
      if (!assignment.abort.signal.aborted) invocationState.logicalAbort = true;
      stop(context.signal.reason);
    };
    const receiptAuthority = collectionReceiptInvocation(context);
    const receiptPrincipal = receiptAuthority
      ? `invocation:${
        JSON.stringify([
          receiptAuthority.scope.databaseSchema,
          receiptAuthority.scope.namespace,
          receiptAuthority.invocation.kind,
          receiptAuthority.invocation.id,
          receiptAuthority.invocation.runId,
        ])
      }`
      : undefined;
    const invocationState: Invocation = {
      receiptPrincipal,
      sealed: false,
      logicalAbort: false,
      semanticFailure: false,
      failStream(reason) {
        if (invocationState.streamFailure) return;
        invocationState.streamFailure = { reason };
        invocationState.semanticFailure = true;
        stop(reason);
      },
      calls: new Set(),
      context,
      result,
      removeAbort: () => context.signal.removeEventListener("abort", abort),
    };
    assignment.contexts.set(id, invocationState);
    context.signal.addEventListener("abort", abort, { once: true });
    if (context.signal.aborted) abort();
    let value: unknown;
    try {
      const invocation: CapabilityInvocation = {
        id,
        context: id,
        kind,
        alias,
        args,
        scope: scopeOf(context),
      };
      encodeCapability(invocation);
      notify(assignment, { invocation });
      value = await result.promise;
      check(assignment);
      context.signal.throwIfAborted();
    } catch (error) {
      // Only the trusted transport lifecycle can classify a physical loss.
      // Wire codes and worker-thrown AbortErrors never grant logical replay.
      if (
        assignment.interruption && !invocationState.logicalAbort &&
        !invocationState.semanticFailure
      ) throw assignment.interruption;
      throw error;
    } finally {
      context.signal.removeEventListener("abort", abort);
      invocationState.sealed = true;
      while (invocationState.calls.size) {
        await Promise.allSettled([...invocationState.calls]);
      }
      // Leaked handles must settle before publishing an Action result.
      const resources = [...assignment.resources.values()].filter((resource) =>
        resource.context === id
      );
      try {
        await Promise.all(
          resources.map((resource) => closeResource(assignment, resource)),
        );
      } finally {
        assignment.contexts.delete(id);
      }
    }
    // A result may have arrived before a checkpoint failed during cleanup.
    // Successful fencing cannot turn that latched failure into Action success.
    if (invocationState.streamFailure) {
      throw invocationState.streamFailure.reason;
    }
    return value;
  };
  const rehost = (assignment: Assignment): PluginRegistry => {
    const registry = options.registry;
    const actions = Object.fromEntries(
      Object.entries(registry.actions).map((
        [alias, action],
      ) => [
        alias,
        {
          ...action,
          execute: (input: unknown, context: ActionContext) =>
            invoke(assignment, "action", alias, [input], context),
          ...(action.resume
            ? {
              resume: (
                handoff: unknown,
                outcome: unknown,
                context: ActionContext,
              ) =>
                invoke(
                  assignment,
                  "resume",
                  alias,
                  [handoff, outcome],
                  context,
                ),
            }
            : {}),
          ...((action as unknown as RecordValue).reconcile
            ? {
              reconcile: (step: unknown, context: ActionContext) =>
                invoke(assignment, "reconcile", alias, [step], context),
            }
            : {}),
        },
      ]),
    );
    const processors = Object.fromEntries(
      Object.entries(registry.processors).map((
        [alias, processor],
      ) => [
        alias,
        ["serverActionRequest", "serverCollectionMutationRequest"].includes(
            alias,
          )
          ? processor
          : {
            ...processor,
            handle: (event: unknown, context: ProcessorContext) =>
              invoke(assignment, "processor", alias, [event], context).then(
                () => undefined,
              ),
            ...(processor.onError
              ? {
                onError: (
                  error: unknown,
                  event: unknown,
                  context: ProcessorContext,
                ) =>
                  invoke(
                    assignment,
                    "processorError",
                    alias,
                    [error, event],
                    context,
                  ) as Promise<boolean>,
              }
              : {}),
          },
      ]),
    );
    return {
      ...registry,
      actions,
      processors,
      processorForConsumer(id) {
        const processor = registry.processorForConsumer(id);
        return processor &&
          Object.values(processors).find((candidate) =>
            candidate.id === processor.id
          );
      },
    } as PluginRegistry;
  };
  const addResource = (
    assignment: Assignment,
    resource: Omit<Resource, "id" | "created" | "used" | "closed" | "serial">,
    reservation?: ResourceReservation,
  ): Resource => {
    if (reservation) {
      // The exact slot already owns admission and pending cleanup. Preserve its
      // closed/serial state if cancellation arrived while physical open waited.
      Object.assign(reservation.resource, resource);
      reservation.consumed = true;
      reservation.ready.resolve(resource.close);
      return reservation.resource;
    }
    if (assignment.resources.size >= MAX_RESOURCES) {
      throw capabilityError("owner_capacity");
    }
    const value: Resource = {
      ...resource,
      id: crypto.randomUUID(),
      created: Date.now(),
      used: Date.now(),
      closed: false,
      serial: Promise.resolve(),
    };
    assignment.resources.set(value.id, value);
    return value;
  };
  const reserveResource = (
    assignment: Assignment,
    context: string,
  ): ResourceReservation => {
    const ready = Promise.withResolvers<Resource["close"] | undefined>();
    const resource = addResource(assignment, {
      kind: "reader",
      context,
      value: {},
      async close(reason) {
        const cleanup = await ready.promise;
        await cleanup?.(reason);
      },
    });
    return { resource, ready, consumed: false };
  };
  const exposeResult = async (
    assignment: Assignment,
    context: string,
    value: unknown,
    reservation?: ResourceReservation,
  ): Promise<unknown> => {
    if (value instanceof ReadableStream) {
      const reader = value.getReader();
      let remainder: Uint8Array | undefined;
      const resource = addResource(assignment, {
        kind: "reader",
        context,
        value: {
          async read() {
            const next = remainder
              ? { done: false, value: remainder }
              : await reader.read();
            if (next.done) return { done: true };
            if (!(next.value instanceof Uint8Array)) {
              throw capabilityError("owner_data_invalid");
            }
            remainder = next.value.length > 64 * 1024
              ? next.value.subarray(64 * 1024)
              : undefined;
            return { done: false, value: next.value.subarray(0, 64 * 1024) };
          },
        },
        async close(reason) {
          await reader.cancel(reason);
          reader.releaseLock();
        },
      }, reservation);
      return { $ownerResource: "reader", handle: resource.id };
    }
    if (
      value && typeof value === "object" &&
      typeof (value as RecordValue).append === "function" &&
      typeof (value as RecordValue).abort === "function"
    ) {
      const writer = value as RecordValue;
      const resource = addResource(assignment, {
        kind: "writer",
        context,
        value: writer,
        async close(reason) {
          await (writer.abort as Method)({
            reason: reason instanceof Error
              ? reason.message
              : "worker_context_closed",
            outcome: "cancelled",
          });
        },
      }, reservation);
      const invocation = assignment.contexts.get(context);
      resource.removeFailure = observeContentStreamFailure(writer, (reason) => {
        // A timer may notify from its completed call scope. Resource cleanup
        // still enters the exact writer facade and checks its current policy.
        void withoutOwnerCommandAuthorization(() => {
          invocation?.failStream(reason);
        });
      });
      return {
        $ownerResource: "writer",
        handle: resource.id,
        id: writer.id,
        offset: (writer.offset as Method)(),
        ...(typeof Object.getOwnPropertyDescriptor(writer, "retain")?.value ===
            "function"
          ? { retainAfterClose: true }
          : {}),
      };
    }
    if (
      value && typeof value === "object" &&
      (value as RecordValue).body instanceof ReadableStream
    ) {
      const record = value as RecordValue;
      // Followers carry an executable lifecycle; retain it with the reader only.
      return {
        bodyId: record.bodyId,
        offset: record.offset,
        mediaType: record.mediaType,
        body: await exposeResult(assignment, context, record.body, reservation),
      };
    }
    return value;
  };
  const snapshot = async (
    assignment: Assignment,
    contextId: string,
    context: ProcessorContext | ActionContext,
  ) => {
    if (assignment.resources.size >= MAX_RESOURCES) {
      throw capabilityError("owner_capacity");
    }
    if (assignment.snapshotOpen) {
      throw capabilityError("owner_snapshot_nested");
    }
    assignment.snapshotOpen = true;
    const opened = Promise.withResolvers<RecordValue>();
    const exit = Promise.withResolvers<void>();
    const wake = { current: Promise.withResolvers<void>() };
    const jobs: {
      path: readonly string[];
      args: readonly unknown[];
      result: Deferred<unknown>;
    }[] = [];
    let closing = false;
    let closeError: unknown;
    let cleanup:
      | Promise<import("../events/session.ts").SqlSnapshotCleanup>
      | undefined;
    const task = context.readSnapshot(async (scope) => {
      const control = snapshotControl(scope);
      if (!control) throw capabilityError("owner_snapshot_unavailable");
      cleanup = control.cleanup;
      const schema = context.databaseSchema;
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) {
        throw capabilityError("owner_snapshot_scope");
      }
      const validate = async () => {
        assignment.abort.signal.throwIfAborted();
        const read = async (
          query: import("../events/session.ts").SqlExecutor,
        ) => {
          const result = await query.query<{ epoch: number | string }>(
            `SELECT epoch FROM "${schema}".owner_epochs WHERE owner='schema'`,
          );
          if (
            Number(result.rows[0]?.epoch) !==
              assignment.binding.parent!.metadata.ownerEpoch
          ) {
            throw capabilityError("ActionOwnershipLost");
          }
        };
        if (control.kind === "pooled") await control.current(read);
        else await read(control.snapshot);
      };
      await validate();
      opened.resolve(scope);
      while (!closing || jobs.length) {
        const job = jobs.shift();
        if (!job) {
          await wake.current.promise;
          wake.current = Promise.withResolvers<void>();
          continue;
        }
        try {
          check(assignment);
          const value = await callPath(scope, job.path, job.args);
          await validate();
          check(assignment);
          job.result.resolve(value);
        } catch (error) {
          job.result.reject(error);
        }
      }
      if (closeError) throw closeError;
    });
    void task.then(exit.resolve, (error) => {
      opened.reject(error);
      exit.reject(error);
    });
    void opened.promise.catch(() => undefined);
    void exit.promise.catch(() => undefined);
    const resource = addResource(assignment, {
      kind: "snapshot",
      context: contextId,
      value: {},
      async close(reason) {
        closing = true;
        closeError = reason;
        wake.current.resolve();
        let failed = false;
        let failure: unknown;
        try {
          await exit.promise;
        } catch (error) {
          failed = true;
          failure = error;
        } finally {
          assignment.snapshotOpen = false;
        }
        // Unknown cleanup takes precedence over callback failure; a confirmed
        // cleanup preserves the original callback error without throwing from
        // finally (including an explicitly thrown undefined value).
        if (!cleanup || (await cleanup) !== "confirmed") {
          throw capabilityError("owner_cleanup_unknown");
        }
        if (failed) throw failure;
      },
      run(path, args) {
        const result = Promise.withResolvers<unknown>();
        jobs.push({ path, args, result });
        wake.current.resolve();
        return result.promise;
      },
    });
    try {
      await opened.promise;
      check(assignment);
      return { handle: resource.id };
    } catch (error) {
      await closeResource(assignment, resource, error).catch(() => undefined);
      throw error;
    }
  };
  const execute = async (
    binding: WorkerCallContext,
    call: CapabilityCall,
  ): Promise<unknown> => {
    if (closed) throw capabilityError("owner_closed");
    if (!binding.parent) {
      if (call.kind !== "receipt" || !options.lookupReceipt) {
        throw capabilityError("owner_capability_refused");
      }
      return await options.lookupReceipt(binding.fence.identity, call.value);
    }
    const key = keyOf(binding);
    let assignment = assignments.get(key);
    if (call.kind === "open") {
      if (assignment) throw capabilityError("owner_assignment_started");
      if (assignments.size >= MAX_ASSIGNMENTS) {
        throw capabilityError("owner_capacity");
      }
      assignment = {
        key,
        binding,
        abort: new AbortController(),
        contexts: new Map(),
        resources: new Map(),
        queue: [],
        task: Promise.resolve(),
        heartbeatSequence:
          sessions?.assertCurrent(binding.fence).nextHeartbeatSequence ?? 0,
      };
      const active = assignment;
      assignments.set(key, active);
      try {
        active.authority = await options.resolveAuthority(
          String(binding.parent.metadata.databaseSchema),
        );
        check(active);
        binding.signal.throwIfAborted();
        const workloads = options.createWorkloads({
          registry: rehost(active),
          workerId: binding.fence.identity.workerId,
          localExecution: options.localExecution,
          trackAttempt: options.localExecution ? undefined : (attempt) => {
            if (active.attempt) {
              throw capabilityError("owner_assignment_started");
            }
            sessions!.assertCurrent(active.binding.fence);
            active.abort.signal.throwIfAborted();
            attempt.signal.throwIfAborted();
            active.attempt = attempt;
            const remove = () => {
              if (active.attempt === attempt) active.attempt = undefined;
              pendingHeartbeats.delete(active);
              attempt.signal.removeEventListener("abort", remove);
            };
            attempt.signal.addEventListener("abort", remove, { once: true });
            return remove;
          },
          onDiagnostic: options.onDiagnostic,
        });
        const workload = workloads[binding.parent.workload];
        if (!workload) throw capabilityError("owner_workload_refused");
        if (!(call.value instanceof Uint8Array)) {
          throw capabilityError("owner_data_invalid");
        }
        const bytes = call.value;
        const work: WorkerWorkContext = {
          streamId: binding.parent.streamId,
          workload: binding.parent.workload,
          metadata: binding.parent.metadata,
          input: new ReadableStream({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          }),
          signal: active.abort.signal,
          sendMetadata: () => Promise.resolve(),
          callHost: () =>
            Promise.reject(capabilityError("owner_internal_call")),
        };
        active.task = Promise.resolve().then(() => workload(work)).then(
          (result) => {
            active.terminal = { result };
          },
          (error) => {
            active.terminal = { error };
          },
        ).finally(() => active.wake?.resolve());
        return undefined;
      } catch (error) {
        abortAssignment(active, error);
        if (assignments.get(key) === active) assignments.delete(key);
        throw error;
      }
    }
    if (!assignment) throw capabilityError("owner_assignment_unknown");
    const active = assignment;
    check(active);
    const abort = () => abortAssignment(active, binding.signal.reason);
    binding.signal.addEventListener("abort", abort, { once: true });
    try {
      // Cancellation may have happened while authority resolution was awaited.
      if (binding.signal.aborted) abort();
      active.abort.signal.throwIfAborted();
      if (call.kind === "next") {
        if (!active.queue.length && !active.terminal) {
          active.wake = Promise.withResolvers<void>();
          const timeout = setTimeout(() => active.wake?.resolve(), POLL_MS);
          try {
            await active.wake.promise;
          } finally {
            clearTimeout(timeout);
            active.wake = undefined;
          }
        }
        check(active);
        const next = active.queue.shift();
        if (next) return next;
        if (active.terminal) {
          await Promise.all(
            [...active.resources.values()].map((resource) =>
              closeResource(active, resource)
            ),
          );
          assignments.delete(key);
          return { done: true, ...active.terminal };
        }
        return {};
      }
      if (call.kind === "complete") {
        const invocation = active.contexts.get(call.id ?? "");
        if (!invocation) throw capabilityError("owner_context_unknown");
        if (invocation.sealed) throw capabilityError("owner_context_closed");
        invocation.sealed = true;
        if (invocation.calls.size) {
          invocation.semanticFailure = true;
          const error = capabilityError("owner_calls_pending");
          invocation.result.reject(error);
          for (const resource of active.resources.values()) {
            if (resource.context === call.id) {
              void closeResource(active, resource, error).catch(() =>
                undefined
              );
            }
          }
        } else if (call.error !== undefined) {
          invocation.semanticFailure = true;
          invocation.result.reject(call.error);
        } else invocation.result.resolve(call.value);
        return undefined;
      }
      const invocation = active.contexts.get(call.context ?? "");
      if (!invocation) throw capabilityError("owner_context_unknown");
      const checkInvocation = () => {
        if (invocation.sealed) throw capabilityError("owner_context_closed");
        invocation.context.signal.throwIfAborted();
      };
      checkInvocation();
      const callDone = Promise.withResolvers<void>();
      invocation.calls.add(callDone.promise);
      try {
        if (call.kind === "snapshot") {
          const result = await snapshot(
            active,
            call.context!,
            invocation.context,
          );
          checkInvocation();
          return result;
        }
        if (call.kind === "close") {
          const resource = active.resources.get(call.id ?? "");
          if (!resource || resource.context !== call.context) {
            throw capabilityError("owner_handle_unknown");
          }
          await closeResource(active, resource, call.error);
          check(active);
          checkInvocation();
          return undefined;
        }
        const path = call.path ?? [];
        const args = call.args ?? [];
        // Runtime placement and causal scope are owner-issued capabilities.
        // A local operation/deduplication key is replay identity, never authority.
        const validateOptions = (value: unknown) => {
          if (!value || typeof value !== "object" || Array.isArray(value)) {
            return;
          }
          const input = value as RecordValue;
          for (
            const field of [
              "databaseSchema",
              "namespace",
              "deliveryLease",
              "ownerEpoch",
              "workerId",
              "context",
            ]
          ) {
            if (Object.hasOwn(input, field)) {
              throw capabilityError("owner_scope_refused");
            }
          }
          if (input.identity && typeof input.identity === "object") {
            const identity = input.identity as RecordValue;
            for (const field of Object.keys(identity)) {
              if (
                ![
                  "causationId",
                  "correlationId",
                  "deduplicationId",
                  "settlementScopeId",
                  "actionScopeId",
                  "metadata",
                ].includes(field)
              ) throw capabilityError("owner_scope_refused");
              if (
                ["settlementScopeId", "actionScopeId"].includes(field) &&
                identity[field] !==
                  invocation.context
                    .identity[field as "settlementScopeId" | "actionScopeId"]
              ) throw capabilityError("owner_scope_refused");
            }
          }
        };
        validateOptions(call.options);
        // Validate only option slots, never domain payloads (an effect outcome or
        // content metadata may legitimately contain a field named namespace).
        if (
          ["actions", "collections", "content", "operations"].includes(path[0])
        ) validateOptions(args[1]);
        if (path[0] === "effect") {
          validateOptions(
            args[
              ["confirm", "notStarted"].includes(path[1]) ? 2 : 1
            ],
          );
        }

        if (call.kind === "transaction") {
          const plan = call.plan;
          if (!Array.isArray(plan) || plan.length > 100) {
            throw capabilityError("owner_plan_limit");
          }
          // Per-operation options are independent authority-bearing inputs. Check
          // the complete plan before entering the transaction or any planner.
          for (const operation of plan) {
            if (
              !operation || !Array.isArray(operation.path) ||
              !Array.isArray(operation.args)
            ) throw capabilityError("owner_plan_invalid");
            validateOptions(operation.args[1]);
          }
          const expectedKey = JSON.stringify([
            invocation.context.namespace,
            invocation.context.operationKey,
            call.options?.operationKey,
          ]);
          const receipt = call.receipt;
          if (
            !receipt || receipt.key !== expectedKey ||
            receipt.databaseSchema !== invocation.context.databaseSchema
          ) throw capabilityError("owner_receipt_scope");
          const intent = capabilityReceiptIntent(
            encodeCapability({ plan, options: call.options }),
          );
          if (!invocation.receiptPrincipal) {
            throw capabilityError("owner_receipt_authority");
          }
          await withCollectionCommandReceipt({
            principal: invocation.receiptPrincipal,
            receiptReader: `worker:${binding.fence.identity.workerId}`,
            receipt: {
              identity: { domain: "logical", key: receipt.key },
              intent,
            },
            signal: invocation.context.signal,
          }, () =>
            invocation.context.transaction(async (scope) => {
              for (const operation of plan) {
                const [root, , method, nested] = operation.path;
                const collection = root === "collections" &&
                  (operation.path.length === 3 &&
                      ["create", "update", "delete"].includes(method) ||
                    operation.path.length === 4 && method === "commands" &&
                      !!nested);
                if (
                  !collection &&
                  !(operation.path.length === 2 &&
                    ["relations", "vectors"].includes(root) &&
                    operation.path[1] === "upsert")
                ) throw capabilityError("owner_plan_invalid");
                await callPath(scope, operation.path, operation.args);
              }
            }, call.options));
          check(active);
          checkInvocation();
          return undefined;
        }
        if (call.kind !== "call") {
          throw capabilityError("owner_capability_refused");
        }
        if (call.id) {
          const resource = active.resources.get(call.id);
          if (
            !resource || resource.context !== call.context || resource.closed
          ) {
            throw capabilityError("owner_handle_unknown");
          }
          resource.used = Date.now();
          if (
            resource.kind === "snapshot"
              ? !allowedPath(path, true)
              : path.length !== 1 || !(resource.kind === "reader"
                ? ["read"]
                : ["append", "close", "abort", "retain"]).includes(path[0])
          ) throw capabilityError("owner_capability_refused");
          const append = resource.kind === "writer" && path[0] === "append";
          if (append && (resource.pendingAppends ?? 0) >= 2) {
            throw capabilityError("owner_append_capacity");
          }
          if (append) {
            resource.pendingAppends = (resource.pendingAppends ?? 0) + 1;
          }
          try {
            const result = resource.serial.then(async () => {
              check(active);
              checkInvocation();
              if (resource.closed) {
                throw capabilityError("owner_handle_unknown");
              }
              // Recheck inside serialization: a queued append must not revive a
              // body whose earlier close has already physically settled.
              if (resource.writerSealed && path[0] !== "retain") {
                throw capabilityError("owner_handle_closed");
              }
              if (
                resource.kind === "writer" && path[0] === "retain" &&
                !resource.writerSealed
              ) throw capabilityError("owner_handle_not_sealed");
              const value = resource.run
                ? await resource.run(path, args)
                : await callPath(resource.value, path, args);
              check(active);
              checkInvocation();
              if (resource.closed) {
                throw capabilityError("owner_handle_unknown");
              }
              if (
                resource.kind === "writer" &&
                ["close", "abort"].includes(path[0])
              ) {
                const retain = Object.getOwnPropertyDescriptor(
                  resource.value,
                  "retain",
                )?.value;
                resource.removeFailure?.();
                resource.removeFailure = undefined;
                if (path[0] === "close" && typeof retain === "function") {
                  // Keep the same MAX_RESOURCES slot and original owner-bound
                  // method, without append/close or physical cleanup authority.
                  // Disposal/invocation cleanup releases this terminal handle.
                  const writer = resource.value;
                  resource.value = {
                    // Keep the authorized callable itself: its .bind property
                    // may be an asynchronous capability facade as well.
                    retain: (...args: unknown[]) =>
                      Reflect.apply(retain, writer, args),
                  };
                  resource.writerSealed = true;
                  resource.close = () => Promise.resolve();
                } else {
                  resource.closed = true;
                  active.resources.delete(resource.id);
                }
              }
              return value;
            });
            resource.serial = result.catch(() => undefined);
            const value = await result;
            check(active);
            checkInvocation();
            return await exposeResult(active, call.context!, value);
          } finally {
            if (append) resource.pendingAppends!--;
          }
        }
        if (!allowedPath(path)) {
          throw capabilityError("owner_capability_refused");
        }
        const opensResource = path[0] === "streams" ||
          path[0] === "content" && ["open", "openCapture"].includes(path[1]);
        // Reserve synchronously before any owner method can open physical I/O.
        const reservation = opensResource
          ? reserveResource(active, call.context!)
          : undefined;
        const callArgs = path[0] === "actions" && path[2] === "prepare"
          ? [
            () =>
              invoke(
                active,
                "prepare",
                String(args[0]),
                [],
                invocation.context,
              ),
            args[1],
          ]
          : args;
        const executeCall = async () =>
          await callPath(invocation.context, path, callArgs);
        try {
          const value = path[0] === "protectedEvent"
            ? await protectedEventResolverFrom(invocation.context)?.()
            : await executeCall();
          // Adopt the physical result into its reserved cleanup slot before any
          // asynchronous output gate can reject it after takeover/cancellation.
          const exposed = await exposeResult(
            active,
            call.context!,
            value,
            reservation,
          );
          if (reservation && !reservation.consumed) {
            reservation.ready.resolve(undefined);
            await closeResource(active, reservation.resource);
          }
          check(active);
          checkInvocation();
          return exposed;
        } catch (error) {
          if (reservation) {
            if (!reservation.consumed) reservation.ready.resolve(undefined);
            await closeResource(active, reservation.resource, error);
          }
          throw error;
        }
      } finally {
        invocation.calls.delete(callDone.promise);
        callDone.resolve();
      }
    } finally {
      binding.signal.removeEventListener("abort", abort);
    }
  };
  const admit: WorkerCallOptions["admit"] = (binding) => {
    if (closed || binding.workload !== OWNER_CAPABILITY_WORKLOAD) {
      return undefined;
    }
    if (!binding.parent && !options.lookupReceipt) return undefined;
    return async ({ input }) => {
      try {
        const call = await readCapability(input) as CapabilityCall;
        if (
          !call || typeof call !== "object" || typeof call.kind !== "string"
        ) throw capabilityError("owner_data_invalid");
        const output = await execute(binding, call);
        return encodeCapability({ value: output });
      } catch (error) {
        return encodeCapability({
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    };
  };
  const retire = async (
    predicate: (assignment: Assignment) => boolean,
    reason: unknown,
  ) => {
    const selected = [...assignments.values()].filter(predicate);
    for (const assignment of selected) abortAssignment(assignment, reason);
    await Promise.allSettled(selected.map(async (assignment) => {
      await assignment.task;
      await Promise.allSettled(
        [...assignment.resources.values()].map((resource) =>
          closeResource(assignment, resource, reason)
        ),
      );
      if (!assignment.resources.size) assignments.delete(assignment.key);
    }));
  };
  return {
    workerCalls: {
      admit,
      admitUnassigned: admit,
      maxConcurrent: 1024,
      maxPerConnection: 128,
      maxRequestBytes: OWNER_CAPABILITY_BYTES,
      maxResponseBytes: OWNER_CAPABILITY_BYTES,
      timeoutMs: 120_000,
    },
    lifecycle: {
      onDisconnect(event) {
        // Oxian invokes this callback synchronously after aborting its calls.
        // Record the private classification before their rejected continuations
        // resume; an already accepted semantic retirement cannot be upgraded.
        for (const assignment of assignments.values()) {
          if (
            assignment.binding.fence.connectionId ===
              event.fence.connectionId &&
            assignment.binding.fence.sessionGeneration ===
              event.fence.sessionGeneration &&
            !assignment.semanticRetirement
          ) assignment.interruption ??= ownerExecutionInterrupted();
        }
        return retire(
          (assignment) =>
            assignment.binding.fence.connectionId ===
              event.fence.connectionId &&
            assignment.binding.fence.sessionGeneration ===
              event.fence.sessionGeneration,
          capabilityError("owner_connection_lost"),
        );
      },
      onComplete(event) {
        for (const assignment of assignments.values()) {
          if (
            assignment.binding.parent?.operationId === event.operationId &&
            assignment.binding.parent.streamId === event.streamId &&
            assignment.binding.fence.connectionId ===
              event.fence.connectionId &&
            assignment.binding.fence.sessionGeneration ===
              event.fence.sessionGeneration
          ) assignment.semanticRetirement = true;
        }
        return retire(
          (assignment) =>
            assignment.binding.parent?.operationId === event.operationId &&
            assignment.binding.parent.streamId === event.streamId &&
            assignment.binding.fence.connectionId ===
              event.fence.connectionId &&
            assignment.binding.fence.sessionGeneration ===
              event.fence.sessionGeneration,
          capabilityError("owner_assignment_ended"),
        );
      },
    },
    async close(reason = "owner_closed") {
      closed = true;
      clearInterval(timer);
      pendingHeartbeats.clear();
      let failure: unknown;
      try {
        unsubscribe?.();
      } catch (error) {
        failure = error;
      }
      await Promise.all([
        retire(() => true, capabilityError(reason)),
        renewing,
      ]);
      if (failure) throw failure;
    },
  };
}
