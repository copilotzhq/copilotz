/** Private bounded owner resource, independent of the serialized command loop.
 * No resource ID grants execution authority and no snapshot is replayed. */
import type {
  SqlExecutor,
  SqlReadSnapshot,
  SqlSession,
  SqlSnapshotCleanup,
} from "../events/session.ts";
import { sameValue } from "../collections/equal.ts";
import type { CollectionFilter } from "../collections/types.ts";
import type { PluginRegistry } from "../plugins/registry.ts";
import type {
  OwnerCaller,
  OwnerCommandBoundary,
  OwnerJson,
} from "./boundary.ts";
import type { OwnerChildActionBinding } from "./child-action.ts";
import { ownerAssignmentFacts } from "./attempt-authority.ts";
import { ownerTableNames } from "./schema.ts";
import {
  ownerAuthorityLock,
  type OwnerAuthorityReadMode,
} from "./authority-read.ts";
import {
  createOwnerCollectionReadEvaluator,
  type OwnerCollectionReadBinding,
} from "./collection-read.ts";
import {
  type OwnerCollectionReadRequest,
  parseOwnerCollectionReadScope,
} from "../execution/collection-read-call.ts";

/** Captured from an existing private placement entry, never from worker data.
 * matches authenticates a fresh per-call witness against that same entry. */
export type OwnerSnapshotLifetime = Readonly<{
  signal: AbortSignal;
  isCurrent(): boolean;
  matches(caller: OwnerCaller): boolean;
}>;
export type OwnerHistoricalReadPolicy = (
  tx: SqlExecutor,
  binding: OwnerCollectionReadBinding,
  request: OwnerCollectionReadRequest,
  time: string,
) =>
  | Readonly<{ historical: true; filter: CollectionFilter }>
  | undefined
  | Promise<
    Readonly<{ historical: true; filter: CollectionFilter }> | undefined
  >;

const abortedGetter = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  "aborted",
)!.get!;
const addAbortListener = EventTarget.prototype.addEventListener;
const removeAbortListener = EventTarget.prototype.removeEventListener;
function aborted(signal: AbortSignal): boolean {
  return abortedGetter.call(signal) as boolean;
}
function affirm(check: () => unknown): boolean {
  try {
    const value = check();
    if (value instanceof Promise) {
      void Promise.prototype.then.call(value, undefined, () => {});
    }
    return value === true;
  } catch {
    return false;
  }
}

function failure(code: string): Error {
  return Object.assign(new Error(code), { code });
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
function facts(binding: OwnerChildActionBinding): OwnerCollectionReadBinding {
  return {
    kind: binding.kind,
    assignment: ownerAssignmentFacts(binding.assignment),
  } as OwnerCollectionReadBinding;
}

export function createOwnerSnapshotResources(
  options: Readonly<{
    session: SqlSession;
    schema: string;
    registry: Pick<PluginRegistry, "collections">;
    owner: Pick<OwnerCommandBoundary, "state" | "epoch" | "stopped">;
    ownerId: string;
    holderId: string;
    capture(caller: OwnerCaller): OwnerSnapshotLifetime | undefined;
    resolve(
      tx: SqlExecutor,
      caller: OwnerCaller,
      time: string,
      mode: OwnerAuthorityReadMode,
    ): Promise<OwnerChildActionBinding | undefined>;
    /** Explicit historical disclosure permission; ordinary filters never imply it. */
    authorizeHistorical?: OwnerHistoricalReadPolicy;
    idleTimeoutMs: number;
    maxLifetimeMs: number;
    maxPendingReads: number;
    now?: () => string;
    /** Owner-level negative outcome; independent of an ended invocation. */
    onCleanupUnknown?(error: Error): void;
  }>,
) {
  const {
    owner,
    ownerId,
    holderId,
    capture,
    resolve,
    authorizeHistorical,
    idleTimeoutMs,
    maxLifetimeMs,
    maxPendingReads,
    onCleanupUnknown,
  } = options;
  for (const value of [idleTimeoutMs, maxLifetimeMs, maxPendingReads]) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError("Positive snapshot limits required.");
    }
  }
  if (Math.max(idleTimeoutMs, maxLifetimeMs) > 2_147_483_647) {
    throw new TypeError("Snapshot timeout exceeds timer range.");
  }
  const capability = options.session.withReadSnapshot?.bind(options.session);
  const prepare = createOwnerCollectionReadEvaluator(options);
  const epochs = ownerTableNames(options.schema).epochs;
  const now = options.now ?? (() => new Date().toISOString());
  type Resource = {
    id: string;
    epoch: number;
    lifetime: OwnerSnapshotLifetime;
    callerSignal?: AbortSignal;
    abort: AbortController;
    phase: "opening" | "open" | "closing" | "quarantined";
    scope?: SqlReadSnapshot;
    binding?: OwnerCollectionReadBinding;
    ready: ReturnType<typeof deferred<string>>;
    gate: ReturnType<typeof deferred<void>>;
    finished: ReturnType<typeof deferred<void>>;
    error?: unknown;
    start: number;
    touched: number;
    pending: number;
    timer?: ReturnType<typeof setTimeout>;
    remove: Array<() => void>;
    cleanup: SqlSnapshotCleanup;
    reports: number;
  };
  let active: Resource | undefined;
  let stopped = false;
  // Cancellation can finish the backend scope before user-supplied policy
  // continuations settle. Keep both budgets across resource generations.
  let pendingReads = 0;
  let pendingAuthority = 0;
  const capacity = () =>
    pendingReads < maxPendingReads && pendingAuthority < maxPendingReads;
  const expired = (r: Resource) => {
    const time = performance.now();
    return (r.phase === "opening" || r.phase === "open") &&
      (time >= r.start + maxLifetimeMs ||
        r.phase === "open" && r.pending === 0 &&
          time >= r.touched + idleTimeoutMs);
  };
  const witness = (r: Resource, caller?: OwnerCaller) => {
    const valid = () =>
      !stopped && owner.state === "acquired" &&
      owner.epoch === r.epoch && !aborted(r.lifetime.signal) &&
      (!r.callerSignal || !aborted(r.callerSignal));
    if (
      !valid() || caller &&
        (caller.ownerEpoch !== r.epoch ||
          !affirm(() => r.lifetime.matches(structuredClone(caller)))) ||
      !affirm(() => r.lifetime.isCurrent()) || !valid()
    ) {
      throw failure("ActionOwnershipLost");
    }
  };
  const current = (r: Resource, caller?: OwnerCaller) => {
    if (expired(r)) {
      seal(r, failure("owner_snapshot_expired"));
      throw failure("owner_snapshot_expired");
    }
    const local = () =>
      active === r &&
      (r.phase === "opening" || r.phase === "open") && !r.abort.signal.aborted;
    if (!local()) throw failure("ActionOwnershipLost");
    witness(r, caller);
    if (!local()) throw failure("ActionOwnershipLost");
    if (expired(r)) {
      seal(r, failure("owner_snapshot_expired"));
      throw failure("owner_snapshot_expired");
    }
  };
  const seal = (
    r: Resource,
    reason: unknown = failure("owner_snapshot_closed"),
  ) => {
    if (r.phase === "closing" || r.phase === "quarantined") return;
    r.phase = "closing";
    r.error = reason;
    clearTimeout(r.timer);
    r.abort.abort(reason);
    r.gate.resolve();
  };
  const arm = (r: Resource) => {
    clearTimeout(r.timer);
    if (r.phase !== "opening" && r.phase !== "open") return;
    const limit = r.phase === "open" && r.pending === 0
      ? Math.min(r.start + maxLifetimeMs, r.touched + idleTimeoutMs)
      : r.start + maxLifetimeMs;
    r.timer = setTimeout(
      () => expired(r) ? seal(r, failure("owner_snapshot_expired")) : arm(r),
      Math.max(0, Math.ceil(limit - performance.now())),
    );
  };
  const authority = async <T>(
    r: Resource,
    caller: OwnerCaller,
    operation: (
      tx: SqlExecutor,
      time: string,
      mode: OwnerAuthorityReadMode,
    ) => Promise<T>,
  ): Promise<T> => {
    current(r, caller);
    const scope = r.scope!;
    const run = async (tx: SqlExecutor, mode: OwnerAuthorityReadMode) => {
      current(r, caller);
      if (pendingAuthority >= maxPendingReads) {
        throw failure("owner_snapshot_capacity");
      }
      pendingAuthority++;
      try {
        const time = now();
        current(r, caller);
        if (!Number.isFinite(Date.parse(time))) {
          throw new TypeError("Valid snapshot authority time required.");
        }
        const fence = async () => {
          const result = await tx.query(
            `SELECT owner FROM ${epochs} WHERE owner=$1 AND epoch=$2 AND holder=$3${
              ownerAuthorityLock(mode, " FOR SHARE")
            }`,
            [ownerId, r.epoch, holderId],
          );
          current(r, caller);
          if (result.rows.length !== 1) throw failure("ActionOwnershipLost");
        };
        await fence();
        const value = await operation(tx, time, mode);
        current(r, caller);
        // Current-lane policies can change durable state in this transaction.
        // A pre-policy fence alone cannot authorize the eventual disclosure.
        await fence();
        current(r, caller);
        return value;
      } finally {
        pendingAuthority--;
      }
    };
    return scope.kind === "exclusive"
      ? await run(scope.snapshot, "exclusive-read")
      : await scope.current((tx) => run(tx, "locking"));
  };
  const live = async (
    r: Resource,
    caller: OwnerCaller,
    tx: SqlExecutor,
    time: string,
    mode: OwnerAuthorityReadMode,
  ) => {
    current(r, caller);
    const binding = structuredClone(
      await resolve(tx, structuredClone(caller), time, mode),
    );
    current(r, caller);
    if (
      !binding || binding.assignment.ownerId !== ownerId ||
      binding.assignment.ctxGranted !== true
    ) {
      throw failure("ActionOwnershipLost");
    }
    const value = facts(binding);
    if (r.binding && !sameValue(r.binding, value)) {
      throw failure("ActionOwnershipLost");
    }
    return structuredClone(value);
  };
  const stop = async () => {
    stopped = true;
    const r = active;
    if (!r) return;
    seal(r);
    await r.finished.promise;
  };
  void owner.stopped.then(() => stop(), () => stop()).catch(() => {});
  return Object.freeze({
    async open(caller: OwnerCaller, signal?: AbortSignal): Promise<string> {
      if (
        stopped || !capability || !authorizeHistorical || active || !capacity()
      ) {
        throw failure("owner_snapshot_unavailable");
      }
      const who = structuredClone(caller);
      const captured = capture(who);
      if (
        !captured || typeof captured.isCurrent !== "function" ||
        typeof captured.matches !== "function"
      ) throw failure("ActionOwnershipLost");
      const lifetime: OwnerSnapshotLifetime = Object.freeze({
        signal: captured.signal,
        isCurrent: Function.prototype.bind.call(captured.isCurrent, captured),
        matches: Function.prototype.bind.call(captured.matches, captured),
      });
      if (
        !(lifetime.signal instanceof AbortSignal) || aborted(lifetime.signal) ||
        signal && (!(signal instanceof AbortSignal) || aborted(signal))
      ) throw failure("ActionOwnershipLost");
      const epoch = owner.epoch;
      if (
        !Number.isSafeInteger(epoch) || epoch! < 1 ||
        who.ownerEpoch !== epoch ||
        owner.state !== "acquired" ||
        !affirm(() => lifetime.matches(who)) ||
        !affirm(() => lifetime.isCurrent()) || aborted(lifetime.signal) ||
        signal && aborted(signal) ||
        stopped || active || !capacity() || owner.state !== "acquired" ||
        owner.epoch !== epoch
      ) throw failure("ActionOwnershipLost");
      const start = performance.now();
      const r: Resource = {
        id: crypto.randomUUID(),
        epoch: epoch!,
        lifetime,
        callerSignal: signal,
        abort: new AbortController(),
        phase: "opening",
        ready: deferred<string>(),
        gate: deferred<void>(),
        finished: deferred<void>(),
        start,
        touched: start,
        pending: 0,
        remove: [],
        cleanup: "unknown",
        reports: 0,
      };
      active = r;
      const complete = (error?: unknown) => {
        clearTimeout(r.timer);
        r.gate.resolve();
        for (const remove of r.remove) remove();
        r.remove.length = 0;
        if (r.cleanup !== "confirmed") {
          r.phase = "quarantined";
          const unknown = Object.assign(
            failure("owner_snapshot_cleanup_unknown"),
            { indeterminate: true },
          );
          r.abort.abort(unknown);
          r.ready.reject(unknown);
          r.finished.reject(unknown);
          try {
            const notified: unknown = onCleanupUnknown?.(unknown);
            if (notified instanceof Promise) {
              void Promise.prototype.then.call(notified, undefined, () => {});
            }
          } catch {
            /* Notification cannot turn unconfirmed cleanup into success. */
          }
          return;
        }
        r.phase = "closing";
        r.abort.abort(r.error ?? error ?? failure("owner_snapshot_closed"));
        if (active === r) active = undefined;
        r.ready.reject(r.error ?? error ?? failure("owner_snapshot_closed"));
        r.finished.resolve();
      };
      let invoked = false;
      try {
        for (const source of [r.lifetime.signal, signal]) {
          if (!source) continue;
          const abort = () => seal(r, failure("owner_snapshot_cancelled"));
          addAbortListener.call(source, "abort", abort, { once: true });
          r.remove.push(() => removeAbortListener.call(source, "abort", abort));
          if (aborted(source)) abort();
        }
        arm(r);
        invoked = true;
        const work = capability(async (scope) => {
          r.scope = scope;
          try {
            r.binding = await authority(
              r,
              who,
              (tx, time, mode) => live(r, who, tx, time, mode),
            );
            current(r, who);
            r.phase = "open";
            r.touched = performance.now();
            arm(r);
            r.ready.resolve(r.id);
            await r.gate.promise;
          } catch (error) {
            seal(r, error);
          }
        }, {
          signal: r.abort.signal,
          onCleanup(value) {
            r.reports++;
            r.cleanup = r.reports === 1 && value === "confirmed"
              ? "confirmed"
              : "unknown";
          },
        });
        void work.then(() => complete(), (error) => complete(error));
      } catch (error) {
        // An invocation may have started before a synchronous failure. Without
        // its explicit cleanup observation, keep the slot quarantined.
        if (!invoked) r.cleanup = "confirmed";
        complete(error);
      }
      try {
        const id = await r.ready.promise;
        current(r, who);
        return id;
      } catch (error) {
        seal(r, error);
        throw error;
      }
    },
    async read(
      id: string,
      caller: OwnerCaller,
      input: unknown,
      signal?: AbortSignal,
    ): Promise<OwnerJson> {
      const r = active;
      if (!r || r.id !== id || r.phase !== "open") {
        throw failure("owner_snapshot_closed");
      }
      const who = structuredClone(caller);
      current(r, who);
      if (!capacity()) {
        throw failure("owner_snapshot_capacity");
      }
      if (signal && !(signal instanceof AbortSignal)) {
        throw new TypeError("Snapshot read signal required.");
      }
      const cancel = () => seal(r, failure("owner_snapshot_cancelled"));
      pendingReads++;
      r.pending++;
      arm(r);
      try {
        if (signal) {
          addAbortListener.call(signal, "abort", cancel, { once: true });
          if (aborted(signal)) cancel();
        }
        current(r, who);
        const plan = prepare(input);
        const allowed = () =>
          authority(r, who, async (tx, time, mode) => {
            const before = await live(r, who, tx, time, mode);
            const grant = structuredClone(
              await authorizeHistorical!(
                tx,
                structuredClone(before),
                structuredClone(plan.request),
                time,
              ),
            );
            current(r, who);
            if (!grant || grant.historical !== true) {
              throw failure("ActionOwnershipLost");
            }
            const filter = parseOwnerCollectionReadScope(grant.filter);
            const after = await live(r, who, tx, time, mode);
            if (!sameValue(before, after)) throw failure("ActionOwnershipLost");
            return { namespace: before.assignment.namespace, filter };
          });
        const before = await allowed();
        current(r, who);
        const finalize = await plan.execute(
          r.scope!.snapshot,
          before.namespace,
          before.filter,
        );
        const after = await allowed();
        current(r, who);
        if (
          before.namespace !== after.namespace ||
          !sameValue(before.filter, after.filter)
        ) throw failure("ActionOwnershipLost");
        const value = finalize();
        current(r, who);
        return value;
      } catch (error) {
        seal(r, error);
        throw error;
      } finally {
        if (signal) removeAbortListener.call(signal, "abort", cancel);
        pendingReads--;
        r.pending--;
        r.touched = performance.now();
        arm(r);
      }
    },
    async close(id: string, caller: OwnerCaller): Promise<void> {
      const r = active;
      if (!r || r.id !== id) throw failure("owner_snapshot_closed");
      // Cleanup needs the exact private caller, not renewed business grants.
      const who = structuredClone(caller);
      if (!affirm(() => r.lifetime.matches(who))) {
        throw failure("ActionOwnershipLost");
      }
      if (expired(r)) seal(r, failure("owner_snapshot_expired"));
      if (r.phase !== "open") {
        await r.finished.promise;
        throw r.error ?? failure("owner_snapshot_closed");
      }
      const closed = failure("owner_snapshot_closed");
      seal(r, closed);
      await r.finished.promise;
      if (r.error !== closed) throw r.error ?? failure("owner_snapshot_closed");
      witness(r, who);
    },
    /** Refuse a same-attempt ordinary call before it can wait for owned capacity. */
    assertOrdinaryAllowed(caller: OwnerCaller): void {
      const r = active;
      if (r && affirm(() => r.lifetime.matches(structuredClone(caller)))) {
        throw failure("owner_snapshot_nested_call");
      }
    },
    stop,
  });
}
