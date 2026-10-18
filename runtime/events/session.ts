import { createEventStoreError } from "./errors.ts";

export type SqlQueryResult<TRow extends Record<string, unknown>> = {
  rows: TRow[];
  rowCount?: number;
};

export type SqlExecutor = {
  query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<SqlQueryResult<TRow>>;
};

export type SqlNotification = Readonly<{
  channel: string;
  payload?: string;
}>;

export type SqlNotificationSubscription = Readonly<{
  close(): Promise<void>;
}>;

/** Explicit per-scope release fact. Missing observation is unknown. */
export type SqlSnapshotCleanup = "confirmed" | "unknown";

/** Long-lived backend resource scope. Its executors accept trusted compiled
 * SQL only; owner Collection APIs never expose arbitrary worker SQL. */
export type SqlReadSnapshot =
  | Readonly<{ kind: "exclusive"; snapshot: SqlExecutor }>
  | Readonly<{
    kind: "pooled";
    snapshot: SqlExecutor;
    current<T>(operation: (transaction: SqlExecutor) => Promise<T>): Promise<T>;
  }>;

export type SqlSession = SqlExecutor & {
  transaction<T>(
    operation: (transaction: SqlExecutor) => Promise<T>,
  ): Promise<T>;
  /**
   * Runs a short, repeatable read-only database snapshot. The callback must
   * finish its selection before content or provider work begins.
   */
  readSnapshot?<T>(
    operation: (snapshot: SqlExecutor) => Promise<T>,
  ): Promise<T>;
  /** Optional operational snapshot/control capability. No plain-read fallback. */
  withReadSnapshot?<T>(
    operation: (scope: SqlReadSnapshot) => Promise<T>,
    options?: Readonly<{
      signal?: AbortSignal;
      onCleanup?: (outcome: SqlSnapshotCleanup) => void;
    }>,
  ): Promise<T>;
  /** Optional PostgreSQL notification seam; absence enables bounded fallback. */
  listen?(
    channel: string,
    handler: (notification: SqlNotification) => void,
  ): Promise<SqlNotificationSubscription>;
};

type DatabaseLike = SqlExecutor & {
  __copilotzTransaction?: <T>(operation: () => Promise<T>) => Promise<T>;
  transaction?: <T>(
    operation: (transaction: SqlExecutor) => Promise<T>,
  ) => Promise<T>;
  listen?: SqlSession["listen"];
  withReadSnapshot?: SqlSession["withReadSnapshot"];
};

/** Adapts an Ominipg/Copilotz database into the narrow atomic-session seam. */
export function createSqlSession(database: DatabaseLike): SqlSession {
  const snapshotCapability = database.withReadSnapshot;
  const query: SqlExecutor["query"] = (sql, params) =>
    database.query(sql, params);
  const transaction: SqlSession["transaction"] = async (operation) => {
    if (typeof database.__copilotzTransaction === "function") {
      return await database.__copilotzTransaction(() => operation({ query }));
    }
    if (typeof database.transaction === "function") {
      return await database.transaction(operation);
    }
    throw createEventStoreError(
      "event_transaction_unavailable",
      "The event store requires an atomic database transaction capability.",
    );
  };

  return {
    query,
    ...(typeof database.listen === "function"
      ? { listen: database.listen.bind(database) }
      : {}),
    transaction,
    ...(typeof snapshotCapability === "function"
      ? { withReadSnapshot: snapshotCapability.bind(database) }
      : {}),
    async readSnapshot(operation) {
      return await transaction(async (snapshot) => {
        await snapshot.query(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
        );
        return await operation(snapshot);
      });
    },
  };
}
