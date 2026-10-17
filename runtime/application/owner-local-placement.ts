/** Dormant private local Action lifecycle. This module performs no SQL and grants
 * no policy authority. The host must supply real command and durable evidence. */
import { assertJsonValue } from "../json.ts";
import {
  type OwnerLocalActionAssignmentBinding,
  parseOwnerPlacementBinding,
} from "../owner/placement-binding.ts";
import { ownerPrincipalIdentity } from "../owner/principal.ts";
import type {
  OwnerCaller,
  OwnerCommandBoundary,
  OwnerCommandContext,
  OwnerCommandOutcome,
} from "../owner/boundary.ts";
import type { SqlExecutor } from "../events/session.ts";
import type {
  createRegisteredLocalActionExecution,
  RegisteredLocalActionReceipt,
} from "../execution/registered-local.ts";

type Reference = OwnerLocalActionAssignmentBinding;
type Driver = Pick<
  ReturnType<typeof createRegisteredLocalActionExecution>,
  "quiescent" | "revoke"
>;
export type OwnerLocalNullLeaseEvidence = Readonly<{
  assignment: Readonly<{
    owner: string;
    epoch: number;
    binding: Reference;
    retired: boolean;
  }>;
  delivery: Readonly<{
    id: string;
    eventId: string;
    consumerId: string;
    status: "leased";
    attempts: 1;
    leaseOwner: string;
    leaseExpiresAt: null;
  }>;
  source: Readonly<{
    id: string;
    namespace: string;
    actionId: string;
    actionRunId: string;
  }>;
}>;
export type OwnerLocalPlacementEntry = Readonly<{
  readonly reference: Reference;
  readonly controlCaller: OwnerCaller;
  readonly localCaller: OwnerCaller;
  executeStart: OwnerCommandBoundary["execute"];
  isCurrent(): boolean;
  onStarted(reference: Reference): void;
  onTerminal(receipt: RegisteredLocalActionReceipt): void;
  /** Attach the actual neutral driver before calling run; quiescence includes
   * its factory, authored code and every admitted raw port call. */
  attachDriver(driver: Driver): void;
  revoke(reason?: unknown): void;
}>;
function failure(message: string): Error {
  return Object.assign(new Error(message), {
    name: "OwnerLocalPlacementError",
    code: "owner_local_placement_refused",
  });
}
function copy<T>(value: T): T {
  assertJsonValue(value, {
    rejectNegativeZero: true,
    maxDepth: 32,
    maxNodes: 4096,
  });
  if (JSON.stringify(value).length > 65536) throw failure("Data limit.");
  return structuredClone(value);
}
function object(value: unknown, keys: readonly string[]) {
  const data = copy(value);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw failure("Own data object required.");
  }
  if (
    Object.keys(data).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(data, key))
  ) throw failure("Exact fields required.");
  return data as Record<string, unknown>;
}
function reference(value: unknown): Reference {
  const result = parseOwnerPlacementBinding(value);
  if (result.placement !== "owner-local" || result.kind !== "action") {
    throw failure("Local Action reference required.");
  }
  return result;
}
function canonical(value: unknown): string {
  const data = copy(value);
  return JSON.stringify(
    data,
    (_, item) =>
      item && typeof item === "object" && !Array.isArray(item)
        ? Object.fromEntries(
          Object.keys(item).sort().map((key) => [key, item[key]]),
        )
        : item,
  );
}
function sameReference(a: unknown, b: Reference): boolean {
  return JSON.stringify(reference(a)) === JSON.stringify(b);
}

export function createOwnerLocalPlacementController(
  options: Readonly<{
    controlCaller: OwnerCaller;
    boundary: Pick<OwnerCommandBoundary, "execute">;
    isCurrent(): boolean;
    /** Shared with worker admission. Must reserve synchronously, before any
     * factory or raw start. Undefined means no allocation was made. */
    capacity: Readonly<{
      reserve(reference: Reference): Readonly<{ release(): void }> | undefined;
    }>;
    /** Includes released tombstones. Reaching the bound refuses new selection;
     * there is no local history replay or unbounded completed-entry cache. */
    maxEntries: number;
    /** Trusted host check of an actual executing boundary context. This pure
     * controller cannot establish SQL provenance from a structural object. */
    authorizeAlarmContext(context: OwnerCommandContext): boolean;
  }>,
) {
  const baseControl = copy(options.controlCaller);
  const principal = baseControl.principal;
  ownerPrincipalIdentity(principal);
  if (
    principal.kind !== "owner-control" ||
    baseControl.ownerEpoch !== principal.epoch ||
    Object.hasOwn(baseControl, "workerId") ||
    Object.hasOwn(baseControl, "localPlacementStart") ||
    Object.hasOwn(baseControl, "localPlacementAttempt")
  ) throw failure("Real owner-control caller required.");
  const fence = { ...principal };
  const execute = options.boundary.execute.bind(options.boundary);
  const reserveCapacity = options.capacity.reserve.bind(options.capacity);
  const isCurrent = options.isCurrent;
  const authorizeAlarmContext = options.authorizeAlarmContext;
  const maxEntries = options.maxEntries;
  if (
    !Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 4096
  ) {
    throw failure("Bounded entry count required.");
  }
  type State = {
    reference: Reference;
    caller: string;
    startCaller: string;
    revoke(reason?: unknown): void;
    current(): boolean;
    startPromise?: Promise<OwnerCommandOutcome>;
    rawPending: boolean;
    authorized?: { tx: SqlExecutor; time: string };
    startKnown: boolean;
    startObserved: boolean;
    terminal?: RegisteredLocalActionReceipt;
    quarantined: boolean;
    released: boolean;
  };
  const entries = new Map<string, State>();
  const reserving = new Set<string>();
  let stopped = false;
  const stop = (reason: unknown = failure("Local placement stopped.")) => {
    if (stopped) return;
    stopped = true;
    for (const state of entries.values()) state.revoke(reason);
  };
  const current = (): boolean => {
    if (stopped) return false;
    try {
      if (isCurrent() === true && !stopped) return true;
    } catch { /* A later successful check cannot restore this lifetime. */ }
    stop(failure("Owner lifetime lost."));
    return false;
  };
  const reserve = (
    input: Reference,
    startKey: string,
  ): OwnerLocalPlacementEntry => {
    const bound = reference(input);
    if (
      !current() || bound.ownerId !== fence.ownerId ||
      bound.epoch !== fence.epoch || bound.holderId !== fence.holderId ||
      typeof startKey !== "string" || !startKey.trim() ||
      startKey.length > 8192 ||
      entries.has(bound.deliveryId) || reserving.has(bound.deliveryId) ||
      entries.size + reserving.size >= maxEntries
    ) throw failure("Fresh bounded local selection required.");
    reserving.add(bound.deliveryId);
    let reservation: Readonly<{ release(): void }> | undefined;
    let releaseCapacity: () => void;
    let allocationReturned = false;
    try {
      reservation = reserveCapacity(copy(bound));
      allocationReturned = true;
      if (reservation instanceof Promise) {
        Promise.prototype.then.call(reservation, () => {}, () => {});
        throw failure("Synchronous capacity reservation required.");
      }
      if (reservation === undefined) {
        throw failure("Shared capacity unavailable.");
      }
      const release = reservation.release;
      if (typeof release !== "function") {
        stop(failure("Invalid capacity reservation."));
        throw failure("Invalid capacity reservation.");
      }
      releaseCapacity = release.bind(reservation);
    } catch (error) {
      // A thrown allocator has no trusted nonallocation witness.
      if (!allocationReturned || reservation !== undefined) stop(error);
      throw error;
    } finally {
      reserving.delete(bound.deliveryId);
    }
    const controlCaller: OwnerCaller = {
      ...copy(baseControl),
      localPlacementStart: crypto.randomUUID(),
    };
    const localCaller: OwnerCaller = {
      principal: {
        kind: "owner-local",
        ownerId: bound.ownerId,
        epoch: bound.epoch,
        holderId: bound.holderId,
        deliveryId: bound.deliveryId,
        attemptId: bound.attemptId,
      },
      ownerEpoch: bound.epoch,
      localPlacementAttempt: crypto.randomUUID(),
    };
    let revoked = false;
    let revokeDriver: ((reason?: unknown) => void) | undefined;
    let driverAttached = false;
    let quiescent = false;
    let releaseAttempted = false;
    const state: State = {
      reference: bound,
      caller: canonical(localCaller),
      startCaller: canonical(controlCaller),
      revoke: (reason) => revoke(reason),
      current: () => {
        if (revoked || state.quarantined || state.released || !current()) {
          return false;
        }
        // The owner callback can synchronously revoke or quarantine this entry.
        return !revoked && !state.quarantined && !state.released;
      },
      rawPending: false,
      startKnown: false,
      startObserved: false,
      quarantined: false,
      released: false,
    };
    const revoke = (reason?: unknown) => {
      if (revoked) return;
      revoked = true;
      try {
        revokeDriver?.(reason);
      } catch {
        stop(failure("Driver revoke failed."));
      }
    };
    const quarantine = (reason: unknown) => {
      state.quarantined = true;
      revoke(reason);
    };
    const maybeRelease = () => {
      if (
        releaseAttempted || state.quarantined || !state.startObserved ||
        !state.terminal || state.rawPending || !quiescent
      ) return;
      releaseAttempted = true;
      revoke(failure("Local terminal observed."));
      try {
        const result: unknown = releaseCapacity();
        if (result !== undefined) {
          // The capacity contract is synchronous. An invalid result can never
          // justify a second release or reuse of this controller.
          if (result instanceof Promise) result.catch(() => {});
          throw failure("Synchronous capacity release required.");
        }
        state.released = true;
      } catch (error) {
        quarantine(error);
        stop(error);
      }
    };
    const handle: OwnerLocalPlacementEntry = {
      get reference() {
        return copy(bound);
      },
      get controlCaller() {
        return copy(controlCaller);
      },
      get localCaller() {
        return copy(localCaller);
      },
      isCurrent: state.current,
      revoke,
      attachDriver(driver) {
        if (driverAttached || state.startPromise || !state.current()) {
          throw failure("Driver attachment refused.");
        }
        const drained = driver.quiescent;
        const revokeMethod = driver.revoke;
        if (
          !(drained instanceof Promise) || typeof revokeMethod !== "function"
        ) {
          throw failure("Actual driver lifetime required.");
        }
        driverAttached = true;
        revokeDriver = revokeMethod.bind(driver);
        Promise.prototype.then.call(drained, () => {
          quiescent = true;
          revoke(failure("Local driver quiescent."));
          maybeRelease();
        }, (error: unknown) => quarantine(error));
      },
      executeStart(caller, command, callOptions = {}) {
        const submitted = object(command, ["kind", "domain", "key", "intent"]);
        if (
          canonical(caller) !== state.startCaller ||
          submitted.kind !== "owner.local-start" ||
          submitted.domain !== "incarnation" || submitted.key !== startKey ||
          !sameReference(submitted.intent, bound)
        ) return Promise.reject(failure("Exact local start required."));
        if (state.startPromise) return state.startPromise;
        let resolve!: (value: OwnerCommandOutcome) => void;
        let reject!: (reason: unknown) => void;
        const optionKeys = Reflect.ownKeys(callOptions);
        const signalProperty = Object.getOwnPropertyDescriptor(
          callOptions,
          "signal",
        );
        if (
          optionKeys.some((key) => key !== "signal") ||
          signalProperty &&
            (!signalProperty.enumerable || !("value" in signalProperty))
        ) return Promise.reject(failure("Own start options required."));
        const signal = signalProperty?.value;
        if (signal !== undefined && !(signal instanceof AbortSignal)) {
          return Promise.reject(failure("Start signal required."));
        }
        state.startPromise = new Promise((yes, no) => {
          resolve = yes;
          reject = no;
        });
        // Publish and charge before invoking a possibly reentrant boundary.
        state.rawPending = true;
        const pending = (async () => {
          try {
            if (!driverAttached || !state.current()) {
              throw failure("Start lifetime closed.");
            }
            const result = object(
              await execute(copy(controlCaller), {
                kind: "owner.local-start",
                domain: "incarnation",
                key: startKey,
                intent: copy(bound),
              }, { signal }),
              ["status", "result"],
            );
            const value = object(result.result, ["binding", "attempts"]);
            if (
              result.status !== "committed" || value.attempts !== 1 ||
              !sameReference(value.binding, bound) || !state.authorized
            ) throw failure("Known authorized fresh start required.");
            state.startKnown = true;
            return {
              status: "committed",
              result: { binding: copy(bound), attempts: 1 },
            } as const;
          } catch (error) {
            quarantine(error);
            throw error;
          } finally {
            state.rawPending = false;
            maybeRelease();
          }
        })();
        pending.then(resolve, reject);
        return state.startPromise;
      },
      onStarted(value) {
        try {
          if (
            !sameReference(value, bound) || !state.startKnown ||
            !state.authorized
          ) {
            throw failure("Unknown local start observation.");
          }
          state.startObserved = true;
          maybeRelease();
        } catch (error) {
          quarantine(error);
          throw error;
        }
      },
      onTerminal(receipt) {
        try {
          const value = object(receipt, ["reference", "status"]);
          if (
            !state.startObserved || !sameReference(value.reference, bound) ||
            !["completed", "failed", "cancelled"].includes(
              value.status as string,
            ) ||
            state.terminal && canonical(state.terminal) !== canonical(value)
          ) throw failure("Exact known local terminal required.");
          state.terminal = copy(receipt);
          maybeRelease();
        } catch (error) {
          quarantine(error);
          throw error;
        }
      },
    };
    entries.set(bound.deliveryId, state);
    // Allocation can call back into stop/current. Retain its charged entry, but
    // never open it after that reentrant lifetime loss.
    if (!current()) revoke(failure("Owner lifetime lost during reservation."));
    return handle;
  };
  return {
    reserve,
    stop,
    resolveCurrentLocal(caller: OwnerCaller): Reference | undefined {
      try {
        const data = copy(caller);
        const p = data.principal;
        ownerPrincipalIdentity(p);
        if (p.kind !== "owner-local") return undefined;
        const state = entries.get(p.deliveryId);
        return state?.startObserved && !state.terminal && state.current() &&
            canonical(data) === state.caller
          ? copy(state.reference)
          : undefined;
      } catch {
        return undefined;
      }
    },
    authorizeStart(
      tx: SqlExecutor,
      caller: OwnerCaller,
      input: Reference,
      time: string,
    ): boolean {
      try {
        const bound = reference(input);
        const state = entries.get(bound.deliveryId);
        if (
          !state?.startPromise || !state.rawPending || state.startKnown ||
          !state.current() || !sameReference(bound, state.reference) ||
          canonical(caller) !== state.startCaller || !tx ||
          typeof time !== "string" || !time.trim() || time.length > 128 ||
          state.authorized &&
            (state.authorized.tx !== tx || state.authorized.time !== time)
        ) return false;
        state.authorized = { tx, time };
        return true;
      } catch {
        return false;
      }
    },
    classifyNullLease(
      context: OwnerCommandContext,
      input: OwnerLocalNullLeaseEvidence,
    ): "pending-start" | "running" | undefined {
      try {
        const data = object(input, ["assignment", "delivery", "source"]);
        const transaction = context.tx;
        const commandTime = context.commandTime;
        const signal = context.signal;
        const commit = { ...context.ownerCommit };
        if (
          !current() || authorizeAlarmContext(context) !== true || !current()
        ) return undefined;
        if (
          commit.transaction !== transaction ||
          commit.ownerId !== fence.ownerId ||
          commit.epoch !== fence.epoch || commit.holderId !== fence.holderId ||
          commit.commandTime !== commandTime || signal.aborted
        ) return undefined;
        const assignment = object(data.assignment, [
          "owner",
          "epoch",
          "binding",
          "retired",
        ]);
        const delivery = object(data.delivery, [
          "id",
          "eventId",
          "consumerId",
          "status",
          "attempts",
          "leaseOwner",
          "leaseExpiresAt",
        ]);
        const source = object(data.source, [
          "id",
          "namespace",
          "actionId",
          "actionRunId",
        ]);
        const bound = reference(assignment.binding);
        const state = entries.get(bound.deliveryId);
        if (
          !state?.current() || state.terminal || !state.authorized ||
          !state.startPromise || !sameReference(bound, state.reference) ||
          assignment.owner !== fence.ownerId ||
          assignment.epoch !== fence.epoch ||
          assignment.retired !== false || delivery.id !== bound.deliveryId ||
          delivery.eventId !== bound.sourceEventId ||
          delivery.consumerId !== `registered:${bound.actionId}` ||
          delivery.status !== "leased" || delivery.attempts !== 1 ||
          delivery.leaseOwner !== bound.attemptId ||
          delivery.leaseExpiresAt !== null ||
          source.id !== bound.sourceEventId ||
          source.namespace !== bound.namespace ||
          source.actionId !== bound.actionId ||
          source.actionRunId !== bound.actionRunId
        ) return undefined;
        return state.startObserved ? "running" : "pending-start";
      } catch {
        return undefined;
      }
    },
  };
}
