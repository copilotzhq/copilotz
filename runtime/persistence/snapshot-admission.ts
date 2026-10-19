import { createAsyncContextStorage } from "../../dependencies/async-hooks.ts";
import type {
  SqlReadSnapshot,
  SqlSession,
  SqlSnapshotCleanup,
} from "../events/session.ts";

type Snapshot = NonNullable<SqlSession["withReadSnapshot"]>;
type Ancestry = readonly { database: object; active: boolean }[];
const ancestry = createAsyncContextStorage<Ancestry | undefined>();
const delegates = new WeakSet<object>();
const attachments = new WeakMap<SqlSession, () => Promise<void>>();
const gates = new WeakMap<object, Gate>();
const MAX_WAITERS = 128;
const ADMISSION_MS = 30_000;

type Permit = {
  controller: AbortController;
  settled: PromiseWithResolvers<void>;
};
type Waiter = {
  grant(): void;
  reject(reason: unknown): void;
};
type Gate = {
  active?: Permit;
  waiting: Waiter[];
  retired: boolean;
  quarantined: boolean;
};

function unavailable(): Error {
  return Object.assign(
    new Error("Application persistence is temporarily unavailable."),
    {
      name: "CopilotzPersistenceUnavailableError",
      status: 503,
      code: "persistence_unavailable",
      retryAfterSeconds: 1,
      retryable: true,
      indeterminate: false,
      generation: 0,
    },
  );
}

function gateFor(database: object): Gate {
  let gate = gates.get(database);
  if (!gate) {
    gate = { waiting: [], retired: false, quarantined: false };
    gates.set(database, gate);
  }
  return gate;
}

function report(
  observer: ((outcome: SqlSnapshotCleanup) => void) | undefined,
  outcome: SqlSnapshotCleanup,
): void {
  try {
    const result: unknown = observer?.(outcome);
    if (result !== undefined) void Promise.resolve(result).catch(() => {});
  } catch { /* Cleanup observation never replaces the operation's outcome. */ }
}

/** Scheduling ancestry only: no authority or retained SQL capability crosses. */
export function captureSnapshotAncestry() {
  const captured = ancestry.getStore();
  return <T>(execute: () => T | Promise<T>): Promise<T> =>
    ancestry.run(captured, execute);
}

/** Only package-created logical wrappers delegate to their selected generation. */
export function markSnapshotDelegate(database: object): void {
  delegates.add(database);
}

export function isSnapshotQuarantined(database: object): boolean {
  return gates.get(database)?.quarantined === true;
}

function rejectWaiting(gate: Gate): void {
  for (const waiter of [...gate.waiting]) waiter.reject(unavailable());
}

/** Retiring never releases capacity ahead of the exact backend promise. */
export function retireSnapshotDatabase(
  database: object,
  reason: unknown = unavailable(),
): Promise<void> {
  const gate = gateFor(database);
  gate.retired = true;
  rejectWaiting(gate);
  gate.active?.controller.abort(reason);
  return gate.active?.settled.promise ?? Promise.resolve();
}

function acquire(gate: Gate, signal?: AbortSignal): Promise<Permit> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  if (gate.retired || gate.quarantined) return Promise.reject(unavailable());
  const permit = () => {
    const value = {
      controller: new AbortController(),
      settled: Promise.withResolvers<void>(),
    };
    gate.active = value;
    return value;
  };
  if (!gate.active) return Promise.resolve(permit());
  if (gate.waiting.length >= MAX_WAITERS) {
    return Promise.reject(unavailable());
  }
  return new Promise<Permit>((resolve, reject) => {
    let pending = true;
    const remove = () => {
      pending = false;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      const index = gate.waiting.indexOf(waiter);
      if (index !== -1) gate.waiting.splice(index, 1);
    };
    const waiter: Waiter = {
      grant() {
        if (!pending) return;
        remove();
        resolve(permit());
      },
      reject(reason) {
        if (!pending) return;
        remove();
        reject(reason);
      },
    };
    const abort = () => waiter.reject(signal?.reason);
    const timer = setTimeout(() => waiter.reject(unavailable()), ADMISSION_MS);
    gate.waiting.push(waiter);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

/** FIFO grants permits; callers resume and execute in their own async context. */
export const withSnapshotAdmission = async <T>(
  database: object,
  capability: Snapshot,
  operation: (scope: SqlReadSnapshot) => Promise<T>,
  options?: Parameters<Snapshot>[1],
): Promise<T> => {
  const observer = options?.onCleanup;
  let cleanup: SqlSnapshotCleanup = "confirmed";
  let permit: Permit | undefined;
  let gate: Gate | undefined;
  let signal: AbortSignal | undefined;
  let abort: (() => void) | undefined;
  try {
    if (observer !== undefined && typeof observer !== "function") {
      throw new TypeError("Snapshot cleanup observer must be a function.");
    }
    signal = options?.signal;
    if (signal?.aborted) throw signal.reason;
    const parents = ancestry.getStore();
    if (parents?.some((scope) => scope.active && scope.database === database)) {
      throw unavailable();
    }
    gate = gateFor(database);
    permit = await acquire(gate, signal);
    const selected = permit;
    abort = () => selected.controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    if (selected.controller.signal.aborted) {
      throw selected.controller.signal.reason;
    }
    let observations = 0;
    cleanup = "unknown";
    const value = await capability(async (scope) => {
      selected.controller.signal.throwIfAborted();
      const token = { database, active: true };
      try {
        return await ancestry.run(
          [...(parents ?? []), token],
          () => {
            selected.controller.signal.throwIfAborted();
            return operation(scope);
          },
        );
      } finally {
        token.active = false;
      }
    }, {
      signal: selected.controller.signal,
      onCleanup(outcome) {
        observations++;
        cleanup = observations === 1 && outcome === "confirmed"
          ? "confirmed"
          : "unknown";
      },
    });
    selected.controller.signal.throwIfAborted();
    return value;
  } finally {
    if (abort) signal?.removeEventListener("abort", abort);
    if (permit && gate) {
      // A cleanup report alone is not a release: we reach here only after the
      // backend's entire promise, including late-open/raw-cleanup, has settled.
      if (cleanup !== "confirmed") gate.quarantined = true;
      gate.active = undefined;
      permit.settled.resolve();
      if (gate.retired || gate.quarantined) rejectWaiting(gate);
      else gate.waiting[0]?.grant();
    }
    report(observer, cleanup);
  }
};

/** Each attachment owns cancellation/drain, but never a borrowed database. */
export function bindSnapshotSession(
  session: SqlSession,
  database: object,
): void {
  const capability = session.withReadSnapshot;
  const lifetime = new AbortController();
  const tasks = new Set<Promise<unknown>>();
  let closing: Promise<void> | undefined;
  attachments.set(session, () => {
    if (!closing) {
      lifetime.abort(unavailable());
      closing = Promise.allSettled([...tasks]).then(() => undefined);
    }
    return closing;
  });
  if (!capability) return;
  session.withReadSnapshot = <T>(
    operation: (scope: SqlReadSnapshot) => Promise<T>,
    options?: Parameters<Snapshot>[1],
  ): Promise<T> => {
    const task = (async () => {
      const observer = options?.onCleanup;
      let reported = false;
      const observe = (outcome: SqlSnapshotCleanup) => {
        if (reported) return;
        reported = true;
        report(observer, outcome);
      };
      let signal: AbortSignal | undefined;
      const combined = new AbortController();
      const abort = () =>
        combined.abort(
          lifetime.signal.aborted ? lifetime.signal.reason : signal?.reason,
        );
      try {
        if (observer !== undefined && typeof observer !== "function") {
          throw new TypeError("Snapshot cleanup observer must be a function.");
        }
        signal = options?.signal;
        lifetime.signal.addEventListener("abort", abort, { once: true });
        signal?.addEventListener("abort", abort, { once: true });
        if (lifetime.signal.aborted || signal?.aborted) abort();
        if (combined.signal.aborted) throw combined.signal.reason;
        const config = { signal: combined.signal, onCleanup: observe };
        const value = await (delegates.has(database)
          ? capability(operation, config)
          : withSnapshotAdmission(database, capability, operation, config));
        if (combined.signal.aborted) {
          throw combined.signal.reason;
        }
        return value;
      } finally {
        lifetime.signal.removeEventListener("abort", abort);
        signal?.removeEventListener("abort", abort);
        if (!reported) observe("confirmed");
      }
    })();
    tasks.add(task);
    void task.then(() => tasks.delete(task), () => tasks.delete(task));
    return task;
  };
}

export function closeSnapshotSession(session: SqlSession): Promise<void> {
  return attachments.get(session)?.() ?? Promise.resolve();
}
