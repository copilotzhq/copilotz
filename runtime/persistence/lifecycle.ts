import {
  type CopilotzOminipgOptions,
  type OminipgDatabaseLike,
  openManagedOminipgDatabase,
} from "./ominipg.ts";
import { createOminipgSqlSession } from "./ominipg.ts";
import type {
  SqlExecutor,
  SqlReadSnapshot,
  SqlSession,
  SqlSnapshotCleanup,
} from "../events/index.ts";

export type CopilotzDatabase = OminipgDatabaseLike;

export type CopilotzDatabaseConnectContext = Readonly<{
  generation: number;
  attempt: number;
  signal: AbortSignal;
}>;

/** A capability that lets Copilotz replace an application-owned connection. */
export type CopilotzDatabaseConnector = Readonly<{
  connect(
    context: CopilotzDatabaseConnectContext,
  ): CopilotzDatabase | Promise<CopilotzDatabase>;
}>;

export type CopilotzDatabaseInput =
  | CopilotzOminipgOptions
  | CopilotzDatabase
  | CopilotzDatabaseConnector;

export type CopilotzPersistenceState =
  | "ready"
  | "unavailable"
  | "reconnecting"
  | "closed";

export type CopilotzPersistenceSnapshot = Readonly<{
  state: CopilotzPersistenceState;
  generation: number;
  reconnectAttempt: number;
  lastError?: unknown;
}>;

export type CopilotzPersistenceLifecycleContext = Readonly<{
  generation: number;
  attempt: number;
  reason?: unknown;
}>;

export type CopilotzPersistenceLifecycleCallbacks = Readonly<{
  onUnavailable?(
    context: CopilotzPersistenceLifecycleContext,
  ): void | Promise<void>;
  onReconnecting?(
    context: CopilotzPersistenceLifecycleContext,
  ): void | Promise<void>;
  onReady?(
    context: CopilotzPersistenceLifecycleContext,
  ): void | Promise<void>;
}>;

export type CopilotzDatabaseRecoveryOptions = Readonly<{
  /** Maximum time a newly admitted operation waits for reconnection. */
  waitMs?: number;
  /** HTTP Retry-After value carried by availability errors. */
  retryAfterSeconds?: number;
  /** Minimum delay before each replacement connection attempt. */
  reconnectDelayMs?: number;
  /** Overrides the conservative database-availability error classifier. */
  isUnavailable?: (error: unknown) => boolean;
}>;

export type CopilotzPersistenceOptions = Readonly<{
  /** Shared stable persistence created by createCopilotzPersistence(). */
  persistence?: CopilotzPersistence;
  /** Database configuration, reconnect capability, or injected open database. */
  database?: CopilotzDatabaseInput;
  databaseRecovery?: CopilotzDatabaseRecoveryOptions;
  /** Observes lifecycle transitions without prescribing application policy. */
  databaseLifecycle?: CopilotzPersistenceLifecycleCallbacks;
}>;

export type CopilotzPersistenceError =
  & Error
  & Readonly<{
    status: 503;
    code: "persistence_unavailable" | "persistence_indeterminate";
    retryAfterSeconds: number;
    retryable: true;
    indeterminate: boolean;
    generation: number;
  }>;

export type CopilotzPersistenceRecoveryParticipant = Readonly<{
  onUnavailable?(error: CopilotzPersistenceError): void | Promise<void>;
  onReady?(snapshot: CopilotzPersistenceSnapshot): void | Promise<void>;
}>;

export type CopilotzPersistenceRecovery = Readonly<{
  snapshot(): CopilotzPersistenceSnapshot;
  /** Waits for the current bounded recovery cycle before admitting new work. */
  admit(): Promise<void>;
  register(
    participant: CopilotzPersistenceRecoveryParticipant,
  ): () => void;
}>;

export type CopilotzPersistence = Readonly<{
  database: CopilotzDatabase;
  ownership: "application" | "injected";
  recovery?: CopilotzPersistenceRecovery;
  close(reason?: string): Promise<void>;
}>;

export type CreateCopilotzPersistenceOptions = Omit<
  CopilotzPersistenceOptions,
  "persistence"
>;

export type OpenCopilotzPersistence =
  & CopilotzPersistence
  & Readonly<{ session: SqlSession }>;

const DEFAULT_RECOVERY_WAIT_MS = 2_000;
const DEFAULT_RETRY_AFTER_SECONDS = 1;

function isDatabase(value: CopilotzDatabaseInput): value is CopilotzDatabase {
  const candidate = value as Partial<CopilotzDatabase>;
  return typeof candidate.query === "function" &&
    typeof candidate.transaction === "function" &&
    typeof candidate.close === "function";
}

function isConnector(
  value: CopilotzDatabaseInput | undefined,
): value is CopilotzDatabaseConnector {
  return Boolean(
    value && !isDatabase(value) &&
      typeof (value as Partial<CopilotzDatabaseConnector>).connect ===
        "function",
  );
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  name: string,
  minimum = 0,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum) {
    throw new TypeError(
      `${name} must be an integer greater than or equal to ${minimum}.`,
    );
  }
  return resolved;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as { code?: unknown }).code;
  if (typeof value === "string" || typeof value === "number") {
    return String(value).toUpperCase();
  }
  return errorCode((error as { cause?: unknown }).cause);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return `${error.message} ${errorMessage(error.cause)}`.trim();
  }
  return typeof error === "string" ? error : "";
}

const OXIAN_SESSION_LOSS_CODES = new Set([
  "connection_lost",
  "indeterminate",
  "worker_unavailable",
  "shutting_down",
]);

/**
 * OminiPG surfaces its Oxian session failure directly or as an Error cause.
 * These terminal transport states do not say whether the SQL operation was
 * observed by the worker, so callers must receive an indeterminate outcome.
 */
function hasOxianSessionLoss(error: unknown): boolean {
  const seen = new Set<object>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const candidate = current as Readonly<{
      name?: unknown;
      code?: unknown;
      cause?: unknown;
    }>;
    if (
      candidate.name === "HypervisorError" &&
      typeof candidate.code === "string" &&
      OXIAN_SESSION_LOSS_CODES.has(candidate.code)
    ) return true;
    current = candidate.cause;
  }
  return false;
}

/** Conservative default: domain, validation, and SQL constraint errors do not reconnect. */
export function isPersistenceUnavailable(error: unknown): boolean {
  if (hasOxianSessionLoss(error)) return true;
  const code = errorCode(error);
  if (
    code &&
    (code.startsWith("08") || [
      "ECONNRESET",
      "ECONNREFUSED",
      "ECONNABORTED",
      "EPIPE",
      "ENETDOWN",
      "ENETRESET",
      "ENETUNREACH",
      "EHOSTUNREACH",
      "57P01",
      "57P02",
      "57P03",
    ].includes(code))
  ) return true;
  return /(?:ominipg (?:session|instance|engine) is closed|workload closed the session unexpectedly|connection (?:terminated|closed|reset|refused)|database connection is unavailable|pool (?:is )?(?:closed|ended)|socket (?:closed|hang up)|broken pipe)/i
    .test(errorMessage(error));
}

function persistenceError(
  code: CopilotzPersistenceError["code"],
  generation: number,
  retryAfterSeconds: number,
  cause?: unknown,
): CopilotzPersistenceError {
  const indeterminate = code === "persistence_indeterminate";
  return Object.assign(
    new Error(
      indeterminate
        ? "Database availability changed while the operation was in flight; its outcome is indeterminate. Retry only with the same idempotency identity."
        : "Application persistence is temporarily unavailable.",
      cause === undefined ? undefined : { cause },
    ),
    {
      name: indeterminate
        ? "CopilotzPersistenceIndeterminateError"
        : "CopilotzPersistenceUnavailableError",
      status: 503 as const,
      code,
      retryAfterSeconds,
      retryable: true as const,
      indeterminate,
      generation,
    },
  );
}

export function isCopilotzPersistenceError(
  error: unknown,
): error is CopilotzPersistenceError {
  return Boolean(
    error && typeof error === "object" &&
      ((error as { code?: unknown }).code === "persistence_unavailable" ||
        (error as { code?: unknown }).code === "persistence_indeterminate"),
  );
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (!milliseconds) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function timeout<T>(
  operation: Promise<T>,
  milliseconds: number,
  error: () => Error,
): Promise<T> {
  if (!milliseconds) return Promise.reject(error());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(error()), milliseconds);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (cause) => {
        clearTimeout(timer);
        reject(cause);
      },
    );
  });
}

async function notify<T>(
  callbacks: readonly ((value: T) => void | Promise<void>)[],
  value: T,
): Promise<void> {
  await Promise.allSettled(callbacks.map((callback) => callback(value)));
}

type DatabaseGeneration = {
  id: number;
  database: CopilotzDatabase;
  active: number;
  retired: boolean;
  lifetime: AbortController;
  closeTask?: Promise<void>;
  startClose?: () => void;
};

function createManagedConnector(
  input: CopilotzOminipgOptions | undefined,
): CopilotzDatabaseConnector {
  return ({
    async connect() {
      return (await openManagedOminipgDatabase(input)).database;
    },
  } as const);
}

async function openRecoverablePersistence(
  connector: CopilotzDatabaseConnector,
  options: CopilotzDatabaseRecoveryOptions,
  lifecycle: CopilotzPersistenceLifecycleCallbacks,
): Promise<OpenCopilotzPersistence> {
  const waitMs = boundedInteger(
    options.waitMs,
    DEFAULT_RECOVERY_WAIT_MS,
    "Database recovery waitMs",
  );
  const retryAfterSeconds = boundedInteger(
    options.retryAfterSeconds,
    DEFAULT_RETRY_AFTER_SECONDS,
    "Database recovery retryAfterSeconds",
  );
  const reconnectDelayMs = boundedInteger(
    options.reconnectDelayMs,
    0,
    "Database reconnectDelayMs",
  );
  const unavailable = options.isUnavailable ?? isPersistenceUnavailable;
  const controller = new AbortController();
  const participants = new Set<CopilotzPersistenceRecoveryParticipant>();
  const generations = new Set<DatabaseGeneration>();
  let state: CopilotzPersistenceState = "reconnecting";
  let current: DatabaseGeneration | undefined;
  let generation = 0;
  let attempt = 0;
  let lastError: unknown;
  let reconnectTask: Promise<void> | undefined;
  let unavailableNotifications: Promise<void> | undefined;
  let closeTask: Promise<void> | undefined;

  const snapshot = (): CopilotzPersistenceSnapshot => ({
    state,
    generation: current?.id ?? generation,
    reconnectAttempt: attempt,
    ...(lastError === undefined ? {} : { lastError }),
  } as const);

  const closeGeneration = (
    value: DatabaseGeneration,
    reason: unknown = persistenceError(
      "persistence_indeterminate",
      value.id,
      retryAfterSeconds,
    ),
  ): Promise<void> => {
    value.retired = true;
    value.lifetime.abort(reason);
    if (!value.closeTask) {
      value.closeTask = new Promise<void>((resolve) => {
        value.startClose = () => {
          value.startClose = undefined;
          void value.database.close().catch(() => undefined).then(() => {
            generations.delete(value);
            resolve();
          });
        };
      });
    }
    if (value.active === 0) value.startClose?.();
    return value.closeTask;
  };

  const lifecycleContext = (
    reason?: unknown,
  ): CopilotzPersistenceLifecycleContext => ({
    generation: current?.id ?? generation,
    attempt,
    ...(reason === undefined ? {} : { reason }),
  } as const);

  const runRecoveryParticipants = async () => {
    const readySnapshot = snapshot();
    await notify(
      [...participants].flatMap((participant) =>
        participant.onReady ? [participant.onReady] : []
      ),
      readySnapshot,
    );
  };

  const connect = async (initial: boolean): Promise<void> => {
    if (state === "closed") return;
    attempt += 1;
    state = "reconnecting";
    if (!initial) {
      await notify(
        lifecycle.onReconnecting ? [lifecycle.onReconnecting] : [],
        lifecycleContext(lastError),
      );
      await delay(reconnectDelayMs, controller.signal);
    }
    const nextId = generation + 1;
    let database: CopilotzDatabase;
    try {
      database = await connector.connect({
        generation: nextId,
        attempt,
        signal: controller.signal,
      });
      if (!isDatabase(database)) {
        throw new TypeError("Database connector returned an invalid database.");
      }
    } catch (error) {
      lastError = error;
      state = controller.signal.aborted ? "closed" : "unavailable";
      if (!initial && state !== "closed") {
        await notify(
          lifecycle.onUnavailable ? [lifecycle.onUnavailable] : [],
          lifecycleContext(error),
        );
      }
      throw error;
    }
    if (controller.signal.aborted) {
      await database.close().catch(() => undefined);
      return;
    }
    const previous = current;
    generation = nextId;
    current = {
      id: generation,
      database,
      active: 0,
      retired: false,
      lifetime: new AbortController(),
    };
    generations.add(current);
    lastError = undefined;
    state = "ready";
    if (previous) void closeGeneration(previous);
    if (!initial) await runRecoveryParticipants();
    await notify(
      lifecycle.onReady ? [lifecycle.onReady] : [],
      lifecycleContext(),
    );
  };

  const reconnect = (): Promise<void> => {
    if (state === "closed") return Promise.resolve();
    reconnectTask ??= (async () => {
      await unavailableNotifications;
      unavailableNotifications = undefined;
      await connect(false);
    })().finally(() => {
      reconnectTask = undefined;
    });
    reconnectTask.catch(() => undefined);
    return reconnectTask;
  };

  const markUnavailable = (error: unknown, failed: DatabaseGeneration) => {
    if (state !== "ready" || current !== failed) return;
    lastError = error;
    state = "unavailable";
    const availability = persistenceError(
      "persistence_indeterminate",
      failed.id,
      retryAfterSeconds,
      error,
    );
    // Revoke retained snapshot handles immediately, before reconnection or
    // observers can await a replacement. Physical close still waits raw users.
    void closeGeneration(failed, availability);
    unavailableNotifications = Promise.all([
      notify(
        lifecycle.onUnavailable ? [lifecycle.onUnavailable] : [],
        lifecycleContext(error),
      ),
      notify(
        [...participants].flatMap((participant) =>
          participant.onUnavailable ? [participant.onUnavailable] : []
        ),
        availability,
      ),
    ]).then(() => undefined);
    void reconnect();
  };

  const acquire = async (): Promise<DatabaseGeneration> => {
    if (state === "closed") {
      throw persistenceError(
        "persistence_unavailable",
        generation,
        retryAfterSeconds,
      );
    }
    if (state !== "ready" || !current) {
      const pending = reconnectTask ?? reconnect();
      try {
        await timeout(pending, waitMs, () =>
          persistenceError(
            "persistence_unavailable",
            generation,
            retryAfterSeconds,
            lastError,
          ));
      } catch (error) {
        if (isCopilotzPersistenceError(error)) throw error;
        throw persistenceError(
          "persistence_unavailable",
          generation,
          retryAfterSeconds,
          error,
        );
      }
    }
    if (state !== "ready" || !current) {
      throw persistenceError(
        "persistence_unavailable",
        generation,
        retryAfterSeconds,
        lastError,
      );
    }
    current.active += 1;
    return current;
  };

  const admit = async (): Promise<void> => {
    if (state === "closed") {
      throw persistenceError(
        "persistence_unavailable",
        generation,
        retryAfterSeconds,
      );
    }
    if (!reconnectTask && state === "ready") return;
    const pending = reconnectTask ?? reconnect();
    try {
      await timeout(pending, waitMs, () =>
        persistenceError(
          "persistence_unavailable",
          generation,
          retryAfterSeconds,
          lastError,
        ));
    } catch (error) {
      if (isCopilotzPersistenceError(error)) throw error;
      throw persistenceError(
        "persistence_unavailable",
        generation,
        retryAfterSeconds,
        error,
      );
    }
  };

  const release = (value: DatabaseGeneration) => {
    value.active = Math.max(0, value.active - 1);
    if (value.retired && value.active === 0) void closeGeneration(value);
  };

  const execute = async <T>(
    operation: (
      database: CopilotzDatabase,
      assertSelected: () => void,
      lifetime: AbortSignal,
    ) => Promise<T>,
    localSignal?: AbortSignal,
    onNotStarted?: () => void,
  ): Promise<T> => {
    let selected: DatabaseGeneration;
    try {
      selected = await acquire();
    } catch (error) {
      onNotStarted?.();
      throw error;
    }
    const assertSelected = () => {
      if (state !== "ready" || current !== selected || selected.retired) {
        throw persistenceError(
          "persistence_indeterminate",
          selected.id,
          retryAfterSeconds,
        );
      }
    };
    try {
      const result = await operation(
        selected.database,
        assertSelected,
        selected.lifetime.signal,
      );
      localSignal?.throwIfAborted();
      assertSelected();
      return result;
    } catch (error) {
      if (isCopilotzPersistenceError(error)) throw error;
      if (localSignal?.aborted && error === localSignal.reason) throw error;
      if (unavailable(error)) {
        markUnavailable(error, selected);
        throw persistenceError(
          "persistence_indeterminate",
          selected.id,
          retryAfterSeconds,
          error,
        );
      }
      throw error;
    } finally {
      release(selected);
    }
  };

  await connect(true);

  const database: CopilotzDatabase = {
    query: (sql, params) => execute((selected) => selected.query(sql, params)),
    transaction: (operation) =>
      execute((selected) => selected.transaction(operation)),
    withReadSnapshot: (operation, options) => {
      // Capture observations independently of later generation/result failures.
      const observer = options?.onCleanup;
      let reported = false;
      const report = (outcome: SqlSnapshotCleanup) => {
        if (reported) return;
        reported = true;
        try {
          const result = observer?.(outcome);
          if (result !== undefined) {
            void Promise.resolve(result).catch(() => {});
          }
        } catch { /* Observation cannot replace the operation's outcome. */ }
      };
      let signal: AbortSignal | undefined;
      try {
        if (observer !== undefined && typeof observer !== "function") {
          throw new TypeError("Snapshot cleanup observer must be a function.");
        }
        signal = options?.signal;
        signal?.throwIfAborted();
      } catch (error) {
        report("confirmed");
        throw error;
      }
      return execute(
        async (selected, assertSelected, generationSignal) => {
          let cleanup: SqlSnapshotCleanup = "confirmed";
          let observations = 0;
          try {
            assertSelected();
            const capability = selected.withReadSnapshot?.bind(selected);
            if (!capability) {
              throw new Error(
                "The selected database does not support scoped snapshots.",
              );
            }
            const lifetime = new AbortController();
            const abort = () =>
              lifetime.abort(
                generationSignal.aborted
                  ? generationSignal.reason
                  : signal?.reason,
              );
            const reader = (executor: SqlExecutor): SqlExecutor => {
              const query = executor.query.bind(executor);
              return Object.freeze({
                async query<
                  TRow extends Record<string, unknown> = Record<
                    string,
                    unknown
                  >,
                >(
                  sql: string,
                  params?: unknown[],
                ) {
                  assertSelected();
                  lifetime.signal.throwIfAborted();
                  const result = await query<TRow>(sql, params);
                  assertSelected();
                  lifetime.signal.throwIfAborted();
                  return result;
                },
              });
            };
            try {
              generationSignal.addEventListener("abort", abort, { once: true });
              signal?.addEventListener("abort", abort, { once: true });
              if (generationSignal.aborted || signal?.aborted) abort();
              // Once invoked, only the backend can confirm this scope's release.
              cleanup = "unknown";
              return await capability(async (scope) => {
                assertSelected();
                lifetime.signal.throwIfAborted();
                const snapshot = reader(scope.snapshot);
                const current = scope.kind === "pooled"
                  ? scope.current.bind(scope)
                  : undefined;
                const wrapped: SqlReadSnapshot = scope.kind === "exclusive"
                  ? { kind: "exclusive", snapshot }
                  : scope.kind === "pooled"
                  ? {
                    kind: "pooled",
                    snapshot,
                    current: async (callback) => {
                      assertSelected();
                      lifetime.signal.throwIfAborted();
                      const result = await current!(async (transaction) => {
                        assertSelected();
                        const value = await callback(reader(transaction));
                        assertSelected();
                        lifetime.signal.throwIfAborted();
                        return value;
                      });
                      assertSelected();
                      lifetime.signal.throwIfAborted();
                      return result;
                    },
                  }
                  : (() => {
                    throw new Error("Unsupported database snapshot scope.");
                  })();
                return await operation(Object.freeze(wrapped));
              }, {
                signal: lifetime.signal,
                onCleanup(outcome) {
                  observations++;
                  cleanup = observations === 1 && outcome === "confirmed"
                    ? "confirmed"
                    : "unknown";
                },
              });
            } finally {
              generationSignal.removeEventListener("abort", abort);
              signal?.removeEventListener("abort", abort);
            }
          } finally {
            report(cleanup);
          }
        },
        signal,
        () => report("confirmed"),
      );
    },
    close: () => close(),
  } as const;

  const close = (): Promise<void> => {
    if (closeTask) return closeTask;
    state = "closed";
    controller.abort(new Error("Copilotz persistence closed."));
    closeTask = Promise.allSettled(
      [
        ...[...generations].map((value) => closeGeneration(value)),
      ],
    ).then(() => undefined);
    return closeTask;
  };

  return ({
    database,
    session: createOminipgSqlSession(database),
    ownership: "application" as const,
    recovery: {
      snapshot,
      admit,
      register(participant: CopilotzPersistenceRecoveryParticipant) {
        participants.add(participant);
        return () => participants.delete(participant);
      },
    } as const,
    close,
  } as const);
}

/** Resolves explicit ownership and adds generation recovery only when reconnectable. */
export async function openCopilotzPersistence(
  options: CopilotzPersistenceOptions,
  lifecycle: CopilotzPersistenceLifecycleCallbacks =
    options.databaseLifecycle ?? {},
): Promise<OpenCopilotzPersistence> {
  if (options.persistence) {
    if (
      options.database !== undefined ||
      options.databaseRecovery !== undefined ||
      options.databaseLifecycle !== undefined
    ) {
      throw new TypeError(
        "Shared persistence cannot be combined with database or database lifecycle options.",
      );
    }
    return ({
      database: options.persistence.database,
      session: createOminipgSqlSession(options.persistence.database),
      ownership: "injected" as const,
      ...(options.persistence.recovery
        ? { recovery: options.persistence.recovery }
        : {}),
      close: () => Promise.resolve(),
    } as const);
  }
  if (options.database && isDatabase(options.database)) {
    return ({
      database: options.database,
      session: createOminipgSqlSession(options.database),
      ownership: "injected" as const,
      close: () => Promise.resolve(),
    } as const);
  }
  const connector = isConnector(options.database)
    ? options.database
    : createManagedConnector(options.database);
  return await openRecoverablePersistence(
    connector,
    options.databaseRecovery ?? {},
    lifecycle,
  );
}

/** Creates one stable persistence record that explicit application roles may share. */
export async function createCopilotzPersistence(
  options: CreateCopilotzPersistenceOptions = {},
  lifecycle: CopilotzPersistenceLifecycleCallbacks =
    options.databaseLifecycle ?? {},
): Promise<CopilotzPersistence> {
  const opened = await openCopilotzPersistence(options, lifecycle);
  return ({
    database: opened.database,
    ownership: opened.ownership,
    ...(opened.recovery ? { recovery: opened.recovery } : {}),
    close: opened.close,
  } as const);
}
