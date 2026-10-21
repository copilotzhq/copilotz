import type {
  SqlReadSnapshot,
  SqlSession,
  SqlSnapshotCleanup,
} from "../events/session.ts";
import { retainReadSnapshotKind } from "../events/snapshot-kind.ts";

type Snapshot = NonNullable<SqlSession["withReadSnapshot"]>;
const delegates = new WeakSet<object>();
const attachments = new WeakMap<SqlSession, () => Promise<void>>();
const gates = new WeakMap<object, Gate>();

type Permit = {
  controller: AbortController;
  settled: PromiseWithResolvers<void>;
};
type Gate = {
  active?: Permit;
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
    gate = { retired: false, quarantined: false };
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

/** Only package-created logical wrappers delegate to their selected generation. */
export function markSnapshotDelegate(database: object): void {
  delegates.add(database);
}

export function isSnapshotQuarantined(database: object): boolean {
  return gates.get(database)?.quarantined === true;
}

/** Retiring never releases capacity ahead of the exact backend promise. */
export function retireSnapshotDatabase(
  database: object,
  reason: unknown = unavailable(),
): Promise<void> {
  const gate = gateFor(database);
  gate.retired = true;
  gate.active?.controller.abort(reason);
  return gate.active?.settled.promise ?? Promise.resolve();
}

/** One physical session; capacity refusal never queues or installs a timer. */
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
    gate = gateFor(database);
    if (gate.active || gate.retired || gate.quarantined) throw unavailable();
    permit = {
      controller: new AbortController(),
      settled: Promise.withResolvers<void>(),
    };
    gate.active = permit;
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
      return await operation(scope);
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
  retainReadSnapshotKind(session.withReadSnapshot, capability);
}

export function closeSnapshotSession(session: SqlSession): Promise<void> {
  return attachments.get(session)?.() ?? Promise.resolve();
}
