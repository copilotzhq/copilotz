/** Private same-owner Processor generation ledger. No SQL, scheduling, policy
 * grants or retained-history adoption; the host supplies real boundary facts. */
import { assertJsonValue } from "../json.ts";
import {
  type OwnerLocalProcessorAssignmentBinding,
  parseOwnerPlacementBinding,
} from "../owner/placement-binding.ts";
import { ownerPrincipalIdentity } from "../owner/principal.ts";
import type {
  OwnerCaller,
  OwnerCommandBoundary,
  OwnerCommandOutcome,
} from "../owner/boundary.ts";
import type { SqlExecutor } from "../events/session.ts";
import type {
  OwnerLocalProcessorAttemptReceipt,
  OwnerLocalProcessorStartFacts,
  OwnerLocalProcessorStartReceipt,
} from "../owner/processor.ts";
import {
  type createRegisteredLocalProcessorExecution,
  parseLocalProcessorAttemptReceipt,
} from "../execution/registered-local-processor.ts";

type Reference = OwnerLocalProcessorAssignmentBinding;
type Driver = Pick<
  ReturnType<typeof createRegisteredLocalProcessorExecution>,
  "quiescent" | "revoke"
>;
export type OwnerLocalProcessorPlacementEntry = Readonly<{
  reference: Reference;
  attemptOrdinal: number;
  controlCaller: OwnerCaller;
  localCaller: OwnerCaller;
  executeStart: OwnerCommandBoundary["execute"];
  isCurrent(): boolean;
  onStarted(receipt: OwnerLocalProcessorStartReceipt): void;
  onEnded(receipt: OwnerLocalProcessorAttemptReceipt): void;
  attachDriver(driver: Driver): void;
  revoke(reason?: unknown): void;
  quarantine(reason: unknown): void;
  /** Bookkeeping wake hint, not active work or authority. Never include this
   * potentially unresolved promise in shutdown's actual-work drain. */
  released: Promise<OwnerLocalProcessorAttemptReceipt>;
}>;
function failure(message: string): Error {
  return Object.assign(new Error(message), {
    name: "OwnerLocalProcessorPlacementError",
    code: "owner_local_processor_placement_refused",
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
function object(
  value: unknown,
  keys: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  const data = copy(value);
  if (
    !data || typeof data !== "object" || Array.isArray(data) ||
    keys.some((k) => !Object.hasOwn(data, k)) ||
    Object.keys(data).some((k) => !keys.includes(k) && !optional.includes(k))
  ) throw failure("Exact own data fields required.");
  return data as Record<string, unknown>;
}
function reference(value: unknown): Reference {
  const result = parseOwnerPlacementBinding(value);
  if (
    result.placement !== "owner-local" || result.kind !== "processor" ||
    result.consumerId !== `processor:${result.processorId}`
  ) throw failure("Local Processor reference required.");
  return result;
}
function canonical(value: unknown): string {
  return JSON.stringify(
    copy(value),
    (_, item) =>
      item && typeof item === "object" && !Array.isArray(item)
        ? Object.fromEntries(Object.keys(item).sort().map((k) => [k, item[k]]))
        : item,
  );
}
function same(a: unknown, b: Reference): boolean {
  return canonical(reference(a)) === canonical(b);
}
function text(value: unknown): value is string {
  return typeof value === "string" && !!value && value === value.trim() &&
    value.length <= 8192;
}
function unchanged(a: Reference, b: Reference): boolean {
  const { attemptId: _a, ...left } = a;
  const { attemptId: _b, ...right } = b;
  return canonical(left) === canonical(right);
}

export function createOwnerLocalProcessorPlacementController(
  options: Readonly<{
    controlCaller: OwnerCaller;
    boundary: Pick<OwnerCommandBoundary, "execute">;
    isCurrent(): boolean;
    capacity: Readonly<
      {
        reserve(
          reference: Reference,
        ): Readonly<{ release(): void }> | undefined;
      }
    >;
    /** Includes every generation's tombstone. Never evict uncertain history. */
    maxEntries: number;
    /** Trusted bounded exact predecessor-row FOR UPDATE proof in the actual
     * start transaction. The pure ledger never accepts caller-supplied proof. */
    predecessorRetired(
      tx: SqlExecutor,
      reference: Reference,
      time: string,
    ): boolean | Promise<boolean>;
  }>,
) {
  const control = copy(options.controlCaller), fence = control.principal;
  ownerPrincipalIdentity(fence);
  if (
    fence.kind !== "owner-control" || control.ownerEpoch !== fence.epoch ||
    Object.hasOwn(control, "workerId") ||
    Object.hasOwn(control, "localProcessorStart") ||
    Object.hasOwn(control, "localProcessorAttempt")
  ) throw failure("Real owner-control caller required.");
  const execute = options.boundary.execute.bind(options.boundary),
    reserveCapacity = options.capacity.reserve.bind(options.capacity),
    isCurrent = options.isCurrent,
    predecessorRetired = options.predecessorRetired,
    maxEntries = options.maxEntries;
  if (
    !Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 4096 ||
    typeof predecessorRetired !== "function"
  ) throw failure("Bounded ledger and predecessor proof required.");
  type State = {
    reference: Reference;
    ordinal: number;
    previous?: State;
    caller: string;
    startCaller: string;
    current(): boolean;
    revoke(reason?: unknown): void;
    quarantine(reason: unknown): void;
    driverAttached: boolean;
    quiescent: boolean;
    revoked: boolean;
    quarantined: boolean;
    released: boolean;
    startPromise?: Promise<OwnerCommandOutcome>;
    rawPending: boolean;
    authorizing: boolean;
    authorized?: {
      tx: SqlExecutor;
      time: string;
      facts: OwnerLocalProcessorStartFacts;
    };
    startKnown: boolean;
    startObserved: boolean;
    end?: OwnerLocalProcessorAttemptReceipt;
  };
  const entries = new Map<string, State>(),
    latest = new Map<string, State>(),
    reserving = new Set<string>(),
    reservingIds = new Set<string>();
  let stopped = false;
  const stop = (
    reason: unknown = failure("Local Processor placement stopped."),
  ) => {
    if (stopped) return;
    stopped = true;
    for (const s of entries.values()) s.revoke(reason);
  };
  const current = () => {
    if (stopped) return false;
    try {
      if (isCurrent() === true && !stopped) return true;
    } catch { /* irreversible */ }
    stop(failure("Owner lifetime lost."));
    return false;
  };
  const retryReady = (s: State) =>
    s.startObserved && s.end?.status === "retry_wait" && s.revoked &&
    s.quiescent && s.released && !s.quarantined;
  const reserve = (
    input: Reference,
    startKey: string,
  ): OwnerLocalProcessorPlacementEntry => {
    const bound = reference(input), previous = latest.get(bound.deliveryId);
    if (
      !current() || bound.ownerId !== fence.ownerId ||
      bound.epoch !== fence.epoch || bound.holderId !== fence.holderId ||
      !text(startKey) || entries.has(bound.attemptId) ||
      reservingIds.has(bound.attemptId) || reserving.has(bound.deliveryId) ||
      entries.size + reserving.size >= maxEntries ||
      previous &&
        (!retryReady(previous) || !unchanged(previous.reference, bound) ||
          previous.ordinal >= Number.MAX_SAFE_INTEGER)
    ) throw failure("Fresh bounded eligible generation required.");
    const ordinal = previous ? previous.ordinal + 1 : 1;
    reserving.add(bound.deliveryId);
    reservingIds.add(bound.attemptId);
    let allocation: Readonly<{ release(): void }> | undefined,
      returned = false,
      releaseCapacity: () => void;
    try {
      allocation = reserveCapacity(copy(bound));
      returned = true;
      if (allocation instanceof Promise) {
        Promise.prototype.then.call(allocation, () => {}, () => {});
        throw failure("Synchronous capacity reservation required.");
      }
      if (allocation === undefined) {
        throw failure("Shared capacity unavailable.");
      }
      const release = allocation.release;
      if (typeof release !== "function") {
        throw failure("Invalid capacity reservation.");
      }
      releaseCapacity = release.bind(allocation);
    } catch (error) {
      if (!returned || allocation !== undefined) stop(error);
      throw error;
    } finally {
      reserving.delete(bound.deliveryId);
      reservingIds.delete(bound.attemptId);
    }
    const controlCaller: OwnerCaller = {
      ...copy(control),
      localProcessorStart: crypto.randomUUID(),
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
      localProcessorAttempt: crypto.randomUUID(),
    };
    let revokeDriver: ((reason?: unknown) => void) | undefined,
      releaseAttempted = false;
    let resolveReleased!: (receipt: OwnerLocalProcessorAttemptReceipt) => void;
    const released = new Promise<OwnerLocalProcessorAttemptReceipt>((done) =>
      resolveReleased = done
    );
    const state: State = {
      reference: bound,
      ordinal,
      previous,
      caller: canonical(localCaller),
      startCaller: canonical(controlCaller),
      driverAttached: false,
      quiescent: false,
      revoked: false,
      quarantined: false,
      released: false,
      rawPending: false,
      authorizing: false,
      startKnown: false,
      startObserved: false,
      current: () => {
        const available = () =>
          !state.revoked && !state.quarantined &&
          !state.released && latest.get(bound.deliveryId) === state;
        return available() && current() && available();
      },
      revoke(reason) {
        if (state.revoked) return;
        state.revoked = true;
        try {
          revokeDriver?.(reason);
        } catch (error) {
          state.quarantined = true;
          stop(error);
        }
      },
      quarantine(reason) {
        state.quarantined = true;
        state.revoke(reason);
      },
    };
    const maybeRelease = () => {
      if (
        releaseAttempted || state.quarantined || !state.startObserved ||
        !state.end || state.rawPending || !state.quiescent
      ) return;
      releaseAttempted = true;
      state.revoke(failure("Processor attempt ended and drained."));
      if (state.quarantined) return;
      try {
        const result: unknown = releaseCapacity();
        if (result !== undefined) {
          if (result instanceof Promise) {
            Promise.prototype.then.call(result, () => {}, () => {});
          }
          throw failure("Synchronous capacity release required.");
        }
        state.released = true;
        // Release may synchronously quarantine this generation or stop the
        // owner. Account for the physical release without publishing a wake.
        if (!state.quarantined && current() && !state.quarantined) {
          resolveReleased(copy(state.end));
        }
      } catch (error) {
        state.quarantine(error);
        stop(error);
      }
    };
    const handle: OwnerLocalProcessorPlacementEntry = {
      get reference() {
        return copy(bound);
      },
      get attemptOrdinal() {
        return ordinal;
      },
      get controlCaller() {
        return copy(controlCaller);
      },
      get localCaller() {
        return copy(localCaller);
      },
      released,
      isCurrent: state.current,
      revoke: state.revoke,
      quarantine: state.quarantine,
      attachDriver(driver) {
        if (state.driverAttached || state.startPromise || !state.current()) {
          throw failure("Driver attachment refused.");
        }
        const drained = driver.quiescent, method = driver.revoke;
        if (!(drained instanceof Promise) || typeof method !== "function") {
          throw failure("Actual driver lifetime required.");
        }
        state.driverAttached = true;
        revokeDriver = method.bind(driver);
        Promise.prototype.then.call(drained, () => {
          state.quiescent = true;
          state.revoke(failure("Processor driver quiescent."));
          maybeRelease();
        }, (error: unknown) => state.quarantine(error));
      },
      executeStart(caller, command, callOptions = {}) {
        const submitted = object(command, ["kind", "domain", "key", "intent"]);
        if (
          canonical(caller) !== state.startCaller ||
          submitted.kind !== "owner.local-processor-start" ||
          submitted.domain !== "incarnation" || submitted.key !== startKey ||
          !same(submitted.intent, bound)
        ) {
          return Promise.reject(
            failure("Exact local Processor start required."),
          );
        }
        if (state.startPromise) return state.startPromise;
        const keys = Reflect.ownKeys(callOptions),
          signalProperty = Object.getOwnPropertyDescriptor(
            callOptions,
            "signal",
          );
        if (
          keys.some((k) => k !== "signal") ||
          signalProperty &&
            (!signalProperty.enumerable || !("value" in signalProperty))
        ) return Promise.reject(failure("Own start options required."));
        const signal = signalProperty?.value;
        if (signal !== undefined && !(signal instanceof AbortSignal)) {
          return Promise.reject(failure("Start signal required."));
        }
        let resolve!: (value: OwnerCommandOutcome) => void,
          reject!: (reason: unknown) => void;
        state.startPromise = new Promise((yes, no) => {
          resolve = yes;
          reject = no;
        });
        state.rawPending = true;
        const pending = (async () => {
          try {
            if (!state.driverAttached || !state.current()) {
              throw failure("Start lifetime closed.");
            }
            const outcome = object(
              await execute(copy(controlCaller), {
                kind: "owner.local-processor-start",
                domain: "incarnation",
                key: startKey,
                intent: copy(bound),
              }, { signal }),
              ["status", "result"],
            );
            const receipt = object(outcome.result, ["binding", "attempts"]);
            if (
              outcome.status !== "committed" || receipt.attempts !== ordinal ||
              !same(receipt.binding, bound) || !state.authorized
            ) throw failure("Known authorized fresh start required.");
            state.startKnown = true;
            return {
              status: "committed",
              result: { binding: copy(bound), attempts: ordinal },
            } as const;
          } catch (error) {
            state.quarantine(error);
            throw error;
          } finally {
            state.rawPending = false;
            maybeRelease();
          }
        })();
        pending.then(resolve, reject);
        return state.startPromise;
      },
      onStarted(receipt) {
        try {
          const data = object(receipt, ["binding", "attempts"]);
          if (
            !state.startKnown || !state.authorized ||
            data.attempts !== ordinal || !same(data.binding, bound)
          ) throw failure("Unknown local start observation.");
          state.startObserved = true;
          maybeRelease();
        } catch (error) {
          state.quarantine(error);
          throw error;
        }
      },
      onEnded(receipt) {
        try {
          if (!state.startObserved || !state.authorized) {
            throw failure("Known start observation required.");
          }
          const data = object(receipt, ["reference", "attempts", "status"], [
            "availableAt",
          ]);
          if (
            !["succeeded", "cancelled", "dead_letter", "retry_wait"].includes(
              data.status as string,
            )
          ) throw failure("Exact ended status required.");
          const completion = data.status === "succeeded"
            ? { status: "succeeded" as const }
            : data.status === "cancelled"
            ? {
              status: "cancelled" as const,
              code: "processor_cancelled" as const,
            }
            : {
              status: "failed" as const,
              code: "processor_failed",
              retryable: data.status === "retry_wait",
            };
          const value = parseLocalProcessorAttemptReceipt(
            data,
            bound,
            ordinal,
            completion,
            state.authorized.facts.maxAttempts,
          );
          if (state.end && canonical(state.end) !== canonical(value)) {
            throw failure("Conflicting ended observation.");
          }
          state.end = copy(value);
          maybeRelease();
        } catch (error) {
          state.quarantine(error);
          throw error;
        }
      },
    };
    entries.set(bound.attemptId, state);
    latest.set(bound.deliveryId, state);
    if (!current() || previous && !retryReady(previous)) {
      state.quarantine(
        failure("Owner or predecessor changed during reservation."),
      );
    }
    return handle;
  };
  const outstanding = (state: State, caller: OwnerCaller, bound: Reference) =>
    state.driverAttached && !!state.startPromise && state.rawPending &&
    !state.startKnown && !state.startObserved && state.current() &&
    same(bound, state.reference) && canonical(caller) === state.startCaller;
  return {
    reserve,
    stop,
    resolveCurrent(
      caller: OwnerCaller,
    ): Readonly<{ reference: Reference; attemptOrdinal: number }> | undefined {
      try {
        const data = copy(caller);
        ownerPrincipalIdentity(data.principal);
        if (data.principal.kind !== "owner-local") return undefined;
        const s = latest.get(data.principal.deliveryId);
        return s?.startObserved && !s.end && s.current() &&
            canonical(data) === s.caller
          ? { reference: copy(s.reference), attemptOrdinal: s.ordinal }
          : undefined;
      } catch {
        return undefined;
      }
    },
    isCurrent(
      caller: OwnerCaller,
      input: Reference,
      ordinal: number,
      phase: "start" | "ctx" | "settlement",
    ): boolean {
      try {
        const bound = reference(input), s = latest.get(bound.deliveryId);
        if (
          !s || s.ordinal !== ordinal || !same(bound, s.reference) ||
          !s.current()
        ) return false;
        if (phase === "start") {
          return !!s.authorized && outstanding(s, caller, bound);
        }
        return (phase === "ctx" || phase === "settlement") && s.startObserved &&
          !s.end && canonical(caller) === s.caller;
      } catch {
        return false;
      }
    },
    async authorizeStart(
      tx: SqlExecutor,
      caller: OwnerCaller,
      input: Reference,
      suppliedFacts: OwnerLocalProcessorStartFacts,
      time: string,
    ): Promise<Readonly<{ attemptOrdinal: number }> | undefined> {
      let state: State | undefined, entered = false;
      try {
        const bound = reference(input),
          who = copy(caller),
          facts = object(suppliedFacts, [
            "status",
            "attempts",
            "maxAttempts",
            "availableAt",
          ]) as OwnerLocalProcessorStartFacts;
        state = latest.get(bound.deliveryId);
        if (
          !state || state.authorizing || !outstanding(state, who, bound) ||
          !tx || typeof tx.query !== "function" || !text(time) ||
          time.length > 128 || !Number.isSafeInteger(facts.attempts) ||
          facts.attempts !== state.ordinal - 1 ||
          !Number.isSafeInteger(facts.maxAttempts) ||
          facts.maxAttempts < state.ordinal || !text(facts.availableAt) ||
          state.authorized &&
            (state.authorized.tx !== tx || state.authorized.time !== time ||
              canonical(state.authorized.facts) !== canonical(facts))
        ) return undefined;
        const previous = state.previous;
        if (
          previous
            ? (!retryReady(previous) || facts.status !== "retry_wait" ||
              previous.end?.status !== "retry_wait" ||
              facts.availableAt !== previous.end.availableAt)
            : facts.status !== "pending" || facts.attempts !== 0
        ) return undefined;
        state.authorizing = true;
        entered = true;
        if (
          previous &&
          await predecessorRetired(tx, copy(previous.reference), time) !== true
        ) return undefined;
        if (
          !outstanding(state, who, bound) || previous && !retryReady(previous)
        ) return undefined;
        state.authorized = { tx, time, facts: copy(facts) };
        return { attemptOrdinal: state.ordinal };
      } catch {
        return undefined;
      } finally {
        if (entered && state) state.authorizing = false;
      }
    },
  };
}
