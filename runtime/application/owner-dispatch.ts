/** Private host composition for durable pre-Open reservations and reverse calls.
 * This module has no public package export and imports no unpublished Oxian API.
 * Install its hooks and wrapped admissions on the SAME Hypervisor, and dispatch
 * only through dispatch(). onStart is deliberately absent: Oxian invokes that
 * hook before work.start and before its current Started-parent check.
 */
import {
  createOwnerAssignmentControl,
  isOwnerProcessorAssignmentBinding,
  type OwnerActionAssignmentBinding,
  type OwnerAssignmentBinding,
  ownerAssignmentKey,
  type OwnerProcessorAssignmentBinding,
} from "../owner/assignments.ts";
import type {
  OwnerCaller,
  OwnerCommand,
  OwnerCommandBoundary,
  OwnerJson,
} from "../owner/boundary.ts";
import type { OwnerWorkerCallContext } from "../owner/connection.ts";
import type { SqlExecutor } from "../events/session.ts";
import { assertJsonValue } from "../json.ts";

type Fence = OwnerWorkerCallContext["fence"];
type Metadata = Readonly<Record<string, OwnerJson>>;
type HandlerInput = Readonly<{
  input: ReadableStream<Uint8Array>;
  signal: AbortSignal;
}>;
type Handler = (input: HandlerInput) => Promise<Uint8Array>;
type Admissions = Readonly<{
  admit(context: OwnerWorkerCallContext):
    | Handler
    | undefined
    | Promise<Handler | undefined>;
  admitUnassigned?(context: OwnerWorkerCallContext):
    | Handler
    | undefined
    | Promise<Handler | undefined>;
}>;
export type OwnerDispatchInput = Readonly<{
  workload: string;
  target?: Readonly<{ workerId: string }>;
  metadata?: Metadata;
  body?: Uint8Array | ReadableStream<Uint8Array>;
  deadlineAtMs?: number;
  signal?: AbortSignal;
}>;
type Handle = Readonly<{
  operationId: string;
  streamId: string;
  completed: Promise<unknown>;
  cancel(reason?: string): Promise<unknown>;
}>;
export type OwnerScheduledAssignment =
  | Pick<
    OwnerActionAssignmentBinding,
    "namespace" | "actionId" | "executionId" | "sourceEventId" | "deliveryId"
  >
  | Pick<
    OwnerProcessorAssignmentBinding,
    "kind" | "processorId" | "namespace" | "sourceEventId" | "deliveryId"
  >;
type Assigned = Readonly<{
  operationId: string;
  workload: string;
  metadata: Metadata;
  signal: AbortSignal;
  assignment: Readonly<{ fence: Fence; streamId: string }>;
}>;
/** Explicit transport hook contract; no inferred private bridge state escapes. */
export type OwnerDispatchAdmissions = Admissions;
export type OwnerDispatchLifecycle = Readonly<{
  onWorkAssigned(context: Assigned): Promise<void>;
  onComplete(
    context: Readonly<{ operationId: string; streamId: string; fence: Fence }>,
  ): void;
  onDisconnect(context: Readonly<{ fence: Fence }>): void;
}>;
type Entry = {
  request: Request;
  owner: OwnerCommandBoundary;
  epoch: number;
  holderId: string;
  fence: Fence;
  binding?: OwnerAssignmentBinding;
  operationId: string;
  streamId: string;
  state: "binding" | "bound" | "retired";
  durable: "none" | "pending" | "known" | "unknown";
  abort: AbortController;
  removeAbort: () => void;
  retirementFailed: boolean;
};
type Request = {
  token: string;
  scheduledKey: string;
  workload: string;
  signal: AbortSignal;
  abort: AbortController;
  entry?: Entry;
  settled: boolean;
  claimed: boolean;
  removeAbort: () => void;
};
type Witness = {
  id: string;
  entry: Entry;
  context: OwnerWorkerCallContext;
  signal: AbortSignal;
  state: "admitting" | "admitted" | "running";
  active: boolean;
  removeAbort: () => void;
};
type ControlWitness = {
  owner: OwnerCommandBoundary;
  epoch: number;
  holderId: string;
  entry: Entry;
  command: OwnerCommand;
};
// Native state reads cannot be shadowed by properties on a callback-visible signal.
const abortedGetter = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  "aborted",
)!.get!;
function isAborted(signal: AbortSignal) {
  return abortedGetter.call(signal) as boolean;
}
function assertActive(signal?: AbortSignal) {
  if (signal && isAborted(signal)) throw refused();
}
function listenAbort(signal: AbortSignal, callback: () => void) {
  EventTarget.prototype.addEventListener.call(signal, "abort", callback, {
    once: true,
  });
  return () =>
    EventTarget.prototype.removeEventListener.call(signal, "abort", callback);
}
function copyFence(fence: Fence): Fence {
  return { ...fence, identity: { ...fence.identity } };
}
const MARKER = "copilotzOwnerDispatch";
const CONTROL = "ownerDispatchControl";
const WITNESS = "ownerDispatchWitness";
const commonBindingFields = [
  "workerId",
  "workerAttemptId",
  "sessionGeneration",
  "sessionId",
  "parentOperationId",
  "assignmentId",
  "dispatchAttemptId",
  "namespace",
  "sourceEventId",
  "deliveryId",
] as const;
function bindingFields(value: OwnerAssignmentBinding) {
  return [
    ...commonBindingFields,
    ...(isOwnerProcessorAssignmentBinding(value)
      ? ["kind", "processorId"]
      : ["actionId", "executionId"]),
  ];
}
function equalBinding(
  a: OwnerAssignmentBinding,
  b: OwnerCaller | OwnerAssignmentBinding,
) {
  const left = a as unknown as Record<string, unknown>;
  const right = b as unknown as Record<string, unknown>;
  const processor = isOwnerProcessorAssignmentBinding(a);
  if (
    processor
      ? (Object.hasOwn(right, "actionId") ||
        Object.hasOwn(right, "executionId"))
      : (Object.hasOwn(right, "kind") || Object.hasOwn(right, "processorId"))
  ) return false;
  if ("principal" in right) {
    const principal = (b as OwnerCaller).principal;
    if (principal.kind !== "worker" || Object.hasOwn(right, "workerId")) {
      return false;
    }
    return bindingFields(a).every((key) =>
      left[key] === (key === "workerId" ? principal.workerId : right[key])
    );
  }
  return bindingFields(a).every((key) => left[key] === right[key]);
}
function equalFence(a: Fence, b: Fence) {
  return a.connectionId === b.connectionId &&
    a.sessionGeneration === b.sessionGeneration &&
    a.identity.workerId === b.identity.workerId &&
    a.identity.attemptId === b.identity.attemptId &&
    a.identity.epoch === b.identity.epoch;
}
function refused() {
  return Object.assign(new Error("Owner dispatch authority unavailable."), {
    code: "owner_dispatch_unavailable",
  });
}
function capacity(value: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100_000) {
    throw new TypeError("Invalid owner dispatch capacity.");
  }
  return value;
}
/** Leave ample room below Oxian's 64 KiB control-frame ceiling for the Open
 * envelope and the private correlation marker. Bodies are never buffered here. */
function dispatchMetadata(value: Metadata | undefined): Metadata {
  const input = value === undefined ? {} : value;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw refused();
  }
  assertJsonValue(input, { maxDepth: 32, maxNodes: 4096 });
  let characters = 0;
  function measure(value: OwnerJson): void {
    if (typeof value === "string") characters += value.length;
    else if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        characters += key.length;
        if (characters > 32 * 1024) throw refused();
        measure(item);
      }
    }
    if (characters > 32 * 1024) throw refused();
  }
  measure(input);
  if (new TextEncoder().encode(JSON.stringify(input)).byteLength > 32 * 1024) {
    throw refused();
  }
  return structuredClone(input);
}
function unknownOutcome(error: unknown) {
  return !!error && typeof error === "object" &&
    (("code" in error &&
      ["owner_commit_unknown", "persistence_indeterminate"].includes(
        String(error.code),
      )) ||
      ("indeterminate" in error && error.indeterminate === true) ||
      ("outcome" in error && error.outcome === "unknown"));
}

export function createOwnerDispatchBridge(
  options: Readonly<{
    ownerId: string;
    schema: string;
    /** Atomic trusted owner/holder pair; successor retirement gets fresh authority. */
    getOwnerAuthority():
      | Readonly<{ boundary: OwnerCommandBoundary; holderId: string }>
      | undefined;
    sessions: Readonly<{
      assertCurrent(fence: Fence): Readonly<{ phase: string }>;
    }>;
    /** Host scheduler lookup. The key comes from dispatch()'s private request,
     * never from worker metadata, input bodies, or lifecycle result reports. */
    resolveScheduled(key: string):
      | OwnerScheduledAssignment
      | undefined
      | Promise<OwnerScheduledAssignment | undefined>;
    /** Mandatory fresh host policy, in addition to the bridge's control witness. */
    authorizeControl(tx: SqlExecutor, caller: OwnerCaller, time: string):
      | void
      | Promise<void>;
    hasProcessor?(processorId: string): boolean;
    maxAssignments?: number;
    maxWitnesses?: number;
  }>,
) {
  const getOwnerAuthority = options.getOwnerAuthority;
  const maxAssignments = capacity(options.maxAssignments ?? 128);
  const maxWitnesses = capacity(options.maxWitnesses ?? 128);
  const requests = new Map<string, Request>();
  const entries = new Map<string, Entry>();
  const witnesses = new Map<string, Witness>();
  const contexts = new WeakMap<OwnerWorkerCallContext, Witness>();
  const controls = new Map<string, ControlWitness>();
  const retirements = new Set<Entry>();
  let pumping: Promise<void> | undefined;
  let retirementArrival = false;
  let closed = false;

  function ownerAuthority() {
    const current = getOwnerAuthority();
    if (!current) return undefined;
    const { boundary: owner, holderId } = current;
    const epoch = owner.epoch;
    if (
      owner.state !== "acquired" || epoch === undefined ||
      !Number.isSafeInteger(epoch) || epoch < 1 ||
      typeof holderId !== "string" || !holderId.trim() || holderId.length > 1024
    ) return undefined;
    return { owner, holderId, epoch };
  }
  function currentOwner(
    owner: OwnerCommandBoundary,
    epoch: number,
    holderId: string,
  ) {
    const current = ownerAuthority();
    return current?.owner === owner && current.epoch === epoch &&
      current.holderId === holderId;
  }
  function currentFence(fence: Fence, preOpen = false) {
    try {
      const session = options.sessions.assertCurrent(copyFence(fence));
      return session.phase === "ready" ||
        (!preOpen && session.phase === "draining");
    } catch {
      return false;
    }
  }
  function currentEntry(entry: Entry, binding = false) {
    return !closed && entries.get(entry.operationId) === entry &&
      entry.state === (binding ? "binding" : "bound") &&
      !isAborted(entry.abort.signal) && !isAborted(entry.request.signal) &&
      currentOwner(entry.owner, entry.epoch, entry.holderId) &&
      currentFence(entry.fence, binding);
  }
  function currentWitness(witness: Witness) {
    return witnesses.get(witness.id) === witness && witness.active &&
      !isAborted(witness.signal) && currentEntry(witness.entry);
  }
  function dropWitness(witness: Witness) {
    witness.active = false;
    witness.removeAbort();
    witnesses.delete(witness.id);
    contexts.delete(witness.context);
  }
  function callerWitness(caller: OwnerCaller): Witness | undefined {
    const id = caller[WITNESS];
    const witness = typeof id === "string" ? witnesses.get(id) : undefined;
    if (
      !witness || !currentWitness(witness) ||
      caller.ownerEpoch !== witness.entry.epoch ||
      !equalBinding(witness.entry.binding!, caller)
    ) return undefined;
    return witness;
  }
  function releaseRequest(request: Request) {
    if (request.settled && !request.entry) {
      request.removeAbort();
      requests.delete(request.token);
    }
  }
  function releaseEntry(entry: Entry) {
    entry.removeAbort();
    entries.delete(entry.operationId);
    retirements.delete(entry);
    entry.request.entry = undefined;
    releaseRequest(entry.request);
  }
  function controlWitness(caller: OwnerCaller): ControlWitness {
    const token = caller[CONTROL];
    const witness = typeof token === "string" ? controls.get(token) : undefined;
    if (
      !witness ||
      !currentOwner(witness.owner, witness.epoch, witness.holderId) ||
      caller.ownerEpoch !== witness.epoch ||
      caller.principal.kind !== "owner-control" ||
      caller.principal.ownerId !== options.ownerId ||
      caller.principal.holderId !== witness.holderId ||
      caller.principal.epoch !== witness.epoch ||
      (witness.command.kind === "assignment.bind" &&
        !currentEntry(witness.entry, true)) ||
      (witness.command.kind === "assignment.retire" &&
        witness.entry.state !== "retired")
    ) {
      throw refused();
    }
    return witness;
  }
  const control = createOwnerAssignmentControl({
    ownerId: options.ownerId,
    schema: options.schema,
    maxActive: maxAssignments,
    hasProcessor: options.hasProcessor,
    async authorizeControl(tx, caller, time) {
      controlWitness(caller);
      await options.authorizeControl(tx, caller, time);
      controlWitness(caller);
    },
    isCurrentStarted: (caller) => callerWitness(caller) !== undefined,
  });
  async function authorizeAssignment(
    tx: SqlExecutor,
    caller: OwnerCaller,
    command: OwnerCommand,
    time: string,
  ) {
    const witness = controlWitness(caller);
    if (
      command.kind !== witness.command.kind ||
      command.domain !== witness.command.domain ||
      command.key !== witness.command.key ||
      !command.intent || typeof command.intent !== "object" ||
      Array.isArray(command.intent) ||
      Object.keys(command.intent).length !==
        bindingFields(witness.entry.binding!).length ||
      !equalBinding(
        witness.entry.binding!,
        command.intent as OwnerAssignmentBinding,
      )
    ) {
      throw refused();
    }
    await control.authorize(tx, caller, command, time);
    controlWitness(caller);
  }
  async function executeControl(
    entry: Entry,
    kind: "assignment.bind" | "assignment.retire",
  ) {
    const authority = kind === "assignment.bind"
      ? {
        owner: entry.owner,
        epoch: entry.epoch,
        holderId: entry.holderId,
      }
      : ownerAuthority();
    if (
      !authority ||
      !currentOwner(authority.owner, authority.epoch, authority.holderId)
    ) throw refused();
    const { owner, epoch, holderId } = authority;
    const command: OwnerCommand = {
      kind,
      domain: "incarnation",
      key: `${ownerAssignmentKey(options.ownerId, entry.binding!)}:${kind}`,
      intent: { ...entry.binding! },
    };
    const token = crypto.randomUUID();
    controls.set(token, { owner, epoch, holderId, entry, command });
    try {
      return await owner.execute(
        {
          principal: {
            kind: "owner-control",
            ownerId: options.ownerId,
            holderId,
            epoch,
          },
          ownerEpoch: epoch,
          [CONTROL]: token,
        },
        structuredClone(command),
        kind === "assignment.bind" ? { signal: entry.abort.signal } : undefined,
      );
    } finally {
      controls.delete(token);
    }
  }
  function scheduleRetirement(entry: Entry) {
    if (entry.durable === "known" || entry.durable === "unknown") {
      if (!retirements.has(entry)) {
        retirements.add(entry);
        if (pumping) retirementArrival = true;
      }
      void retryRetirements();
    }
  }
  function retire(entry: Entry) {
    if (entry.state !== "retired") {
      entry.state = "retired";
      entry.abort.abort(refused());
      // An unresolved admission/handler keeps its capacity slot until finally.
      for (const witness of witnesses.values()) {
        if (witness.entry !== entry) continue;
        witness.active = false;
        if (witness.state === "admitted") dropWitness(witness);
      }
    }
    scheduleRetirement(entry);
  }
  /** Single bounded pass, never a retry loop. Failed rows retain a local slot and
   * remain durable recovery work. A successor may retire an unknown bind; it
   * must reconcile an absent row explicitly outside this bridge. */
  function retryRetirements(): Promise<void> {
    if (pumping) return pumping;
    pumping = Promise.resolve().then(async () => {
      const batch = [...retirements];
      for (const entry of batch) {
        try {
          await executeControl(entry, "assignment.retire");
          releaseEntry(entry);
        } catch {
          entry.retirementFailed = true;
        }
      }
    }).finally(() => {
      pumping = undefined;
      if (retirementArrival) {
        retirementArrival = false;
        void retryRetirements();
      }
    });
    return pumping;
  }
  function retireOperation(operationId: string) {
    const entry = entries.get(operationId);
    if (entry) retire(entry);
  }
  async function onWorkAssigned(context: Assigned): Promise<void> {
    const marker = context.metadata[MARKER];
    const request = typeof marker === "string"
      ? requests.get(marker)
      : undefined;
    const authority = ownerAuthority();
    if (
      !request || request.claimed || request.entry || request.settled ||
      isAborted(request.signal) ||
      isAborted(context.signal) || closed ||
      context.workload !== request.workload ||
      entries.has(context.operationId) ||
      !authority ||
      !currentFence(context.assignment.fence, true)
    ) {
      throw refused();
    }
    const fence = {
      ...context.assignment.fence,
      identity: { ...context.assignment.fence.identity },
    };
    const entry: Entry = {
      request,
      ...authority,
      fence,
      operationId: context.operationId,
      streamId: context.assignment.streamId,
      state: "binding",
      durable: "none",
      abort: new AbortController(),
      removeAbort() {},
      retirementFailed: false,
    };
    request.claimed = true;
    request.entry = entry;
    entries.set(entry.operationId, entry);
    const abort = () => retire(entry);
    const removeHookAbort = listenAbort(context.signal, abort);
    const removeRequestAbort = listenAbort(request.signal, abort);
    entry.removeAbort = () => {
      removeHookAbort();
      removeRequestAbort();
    };
    try {
      const value = await options.resolveScheduled(request.scheduledKey);
      if (!value || !currentEntry(entry, true)) throw refused();
      entry.binding = {
        workerId: fence.identity.workerId,
        workerAttemptId: fence.identity.attemptId,
        sessionGeneration: fence.sessionGeneration,
        sessionId: fence.connectionId,
        parentOperationId: entry.operationId,
        assignmentId: entry.streamId,
        dispatchAttemptId: crypto.randomUUID(),
        namespace: value.namespace,
        ...("kind" in value
          ? { kind: value.kind, processorId: value.processorId }
          : { actionId: value.actionId, executionId: value.executionId }),
        sourceEventId: value.sourceEventId,
        deliveryId: value.deliveryId,
      };
      entry.durable = "pending";
      await executeControl(entry, "assignment.bind");
      entry.durable = "known";
      if (!currentEntry(entry, true)) throw refused();
      entry.state = "bound";
    } catch (error) {
      if (unknownOutcome(error)) {
        entry.durable = "unknown";
        entry.owner.stop(error);
      } else if (entry.durable === "pending") entry.durable = "none";
      retire(entry);
      if (entry.durable === "none") releaseEntry(entry);
      throw error;
    }
  }
  function onComplete(
    context: Readonly<{ operationId: string; streamId: string; fence: Fence }>,
  ) {
    const entry = entries.get(context.operationId);
    if (
      entry && entry.streamId === context.streamId &&
      equalFence(entry.fence, context.fence)
    ) retire(entry);
  }
  function onDisconnect(context: Readonly<{ fence: Fence }>) {
    for (const entry of entries.values()) {
      if (equalFence(entry.fence, context.fence)) retire(entry);
    }
  }
  async function dispatch<H extends Handle>(
    dispatcher: Readonly<{ dispatch(input: OwnerDispatchInput): Promise<H> }>,
    input: OwnerDispatchInput,
    scheduledOperationKey: string,
  ): Promise<H> {
    if (
      closed || requests.size >= maxAssignments ||
      typeof scheduledOperationKey !== "string" ||
      !scheduledOperationKey.trim() ||
      scheduledOperationKey !== scheduledOperationKey.trim() ||
      scheduledOperationKey.length > 1024 ||
      typeof input.workload !== "string" || input.workload.length > 128 ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(input.workload)
    ) throw refused();
    assertActive(input.signal);
    const metadata = dispatchMetadata(input.metadata);
    if (Object.hasOwn(metadata, MARKER)) throw refused();
    const abort = new AbortController();
    const request: Request = {
      token: crypto.randomUUID(),
      scheduledKey: scheduledOperationKey,
      workload: input.workload,
      signal: abort.signal,
      abort,
      settled: false,
      claimed: false,
      removeAbort() {},
    };
    const revoke = () => {
      abort.abort(refused());
      if (request.entry) retire(request.entry);
    };
    request.removeAbort = input.signal
      ? listenAbort(input.signal, revoke)
      : () => {};
    requests.set(request.token, request);
    const finish = () => {
      request.settled = true;
      revoke();
      releaseRequest(request);
    };
    try {
      const handle = await dispatcher.dispatch({
        ...input,
        signal: abort.signal,
        metadata: {
          ...metadata,
          [MARKER]: request.token,
        },
      });
      const entry = request.entry;
      if (
        !entry || entry.operationId !== handle.operationId ||
        entry.streamId !== handle.streamId || !currentEntry(entry)
      ) {
        // Observe terminal failure even for a malformed host handle.
        void handle.completed.catch(() => undefined);
        void handle.cancel("owner assignment unavailable").catch(() =>
          undefined
        );
        throw refused();
      }
      void handle.completed.then(finish, finish);
      return {
        ...handle,
        cancel(reason?: string) {
          revoke();
          return handle.cancel(reason);
        },
      };
    } catch (error) {
      finish();
      throw error;
    }
  }
  function resolveAssignment(context: OwnerWorkerCallContext, ownerId: string) {
    const witness = contexts.get(context);
    if (ownerId !== options.ownerId || !witness || !currentWitness(witness)) {
      return undefined;
    }
    const { workerId, ...binding } = witness.entry.binding!;
    return {
      ownerId,
      caller: {
        ...binding,
        principal: { kind: "worker" as const, workerId },
        ownerEpoch: witness.entry.epoch,
        [WITNESS]: witness.id,
      },
      binding: { ...witness.entry.binding! },
    };
  }
  async function resolveStarted(tx: SqlExecutor, caller: OwnerCaller) {
    const witness = callerWitness(caller);
    if (!witness) return undefined;
    const binding = await control.resolveStarted(tx, caller);
    return binding && callerWitness(caller) === witness &&
        equalBinding(witness.entry.binding!, binding)
      ? binding
      : undefined;
  }
  /** Install ONLY as actual Oxian workerCalls admission. Oxian's current()
   * verifies Started before invoking it; no lifecycle hook or worker payload is
   * permitted to manufacture this callback context. Business grants remain in
   * the wrapped admission and must be refreshed in SQL authorization. */
  function wrapWorkerCalls(admissions: Admissions) {
    return {
      async admit(
        context: OwnerWorkerCallContext,
      ): Promise<Handler | undefined> {
        const parent = context.parent;
        const entry = parent ? entries.get(parent.operationId) : undefined;
        if (
          !entry || !parent || witnesses.size >= maxWitnesses ||
          isAborted(context.signal) ||
          !currentEntry(entry) || !equalFence(entry.fence, context.fence) ||
          parent.streamId !== entry.streamId ||
          parent.workload !== entry.request.workload
        ) return undefined;
        const signal = AbortSignal.any([context.signal, entry.abort.signal]);
        const parentMetadata = structuredClone(parent.metadata) as Record<
          string,
          OwnerJson
        >;
        delete parentMetadata[MARKER];
        const captured: OwnerWorkerCallContext = {
          ...context,
          signal: AbortSignal.any([signal]),
          fence: copyFence(entry.fence),
          parent: {
            ...parent,
            metadata: parentMetadata,
          },
          metadata: structuredClone(context.metadata),
        };
        const witness: Witness = {
          id: crypto.randomUUID(),
          entry,
          context: captured,
          signal,
          state: "admitting",
          active: true,
          removeAbort() {},
        };
        const invalidate = () => {
          witness.active = false;
          if (witness.state === "admitted") dropWitness(witness);
        };
        witness.removeAbort = listenAbort(signal, invalidate);
        witnesses.set(witness.id, witness);
        contexts.set(captured, witness);
        try {
          const handler = await admissions.admit(captured);
          if (!handler || !currentWitness(witness)) {
            dropWitness(witness);
            return undefined;
          }
          witness.state = "admitted";
          return async (input) => {
            if (witness.state !== "admitted") throw refused();
            if (!currentWitness(witness)) {
              dropWitness(witness);
              throw refused();
            }
            witness.state = "running";
            try {
              const executionSignal = AbortSignal.any([input.signal, signal]);
              witness.signal = executionSignal;
              assertActive(executionSignal);
              const output = await handler({
                ...input,
                signal: AbortSignal.any([executionSignal]),
              });
              assertActive(executionSignal);
              if (!currentWitness(witness)) throw refused();
              if (!(output instanceof Uint8Array)) {
                throw new TypeError("Owner call must return bytes.");
              }
              return output;
            } finally {
              dropWitness(witness);
            }
          };
        } catch (error) {
          dropWitness(witness);
          throw error;
        }
      },
      ...(admissions.admitUnassigned
        ? { admitUnassigned: admissions.admitUnassigned.bind(admissions) }
        : {}),
    };
  }
  return {
    assignmentHandlers: control.handlers,
    authorizeAssignment,
    resolveStarted,
    resolveAssignment,
    wrapWorkerCalls,
    lifecycle: { onWorkAssigned, onComplete, onDisconnect },
    dispatch,
    retireOperation,
    retryRetirements,
    stop() {
      closed = true;
      for (const request of requests.values()) request.abort.abort(refused());
      for (const entry of entries.values()) retire(entry);
    },
    snapshot() {
      return {
        requests: requests.size,
        assignments: entries.size,
        witnesses: witnesses.size,
        controls: controls.size,
        retirements: retirements.size,
        failedRetirements:
          [...retirements].filter((entry) => entry.retirementFailed).length,
        closed,
      };
    },
  };
}
