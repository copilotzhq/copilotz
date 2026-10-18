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
  /** Optional PostgreSQL notification seam; absence enables bounded fallback. */
  listen?(
    channel: string,
    handler: (notification: SqlNotification) => void,
  ): Promise<SqlNotificationSubscription>;
};

type TransactionCompletion = {
  state: "pending" | "committed" | "failed";
  callbacks: Array<() => void>;
};

const completions = new WeakMap<SqlExecutor, TransactionCompletion>();

/**
 * Runs one outer SQL transaction. Commit observers run only after the adapter
 * confirms COMMIT; rollback and an unknown commit outcome publish nothing.
 */
export async function runSqlTransaction<T>(
  session: Pick<SqlSession, "transaction">,
  operation: (transaction: SqlExecutor) => Promise<T>,
): Promise<T> {
  const completion: TransactionCompletion = { state: "pending", callbacks: [] };
  let active = false;
  try {
    const result = await session.transaction(async (executor) => {
      active = true;
      const transaction: SqlExecutor = {
        query(sql, params) {
          if (!active) {
            return Promise.reject(new Error("SQL transaction is closed."));
          }
          return executor.query(sql, params);
        },
      };
      completions.set(transaction, completion);
      try {
        return await operation(transaction);
      } finally {
        active = false;
      }
    });
    completion.state = "committed";
    for (const callback of completion.callbacks.splice(0)) callback();
    return result;
  } catch (error) {
    if (completion.state !== "committed") completion.state = "failed";
    completion.callbacks.length = 0;
    throw error;
  }
}

/** Registers an internal synchronous cache update at the outer commit gate. */
export function afterSqlCommit(
  transaction: SqlExecutor,
  callback: () => void,
): void {
  const completion = completions.get(transaction);
  if (!completion || completion.state !== "pending") {
    throw new Error("A managed, active SQL transaction is required.");
  }
  completion.callbacks.push(callback);
}

/** Captures the transaction's output gate without retaining its SQL executor. */
export function sqlCommitGate(transaction: SqlExecutor): () => void {
  const completion = completions.get(transaction);
  if (!completion || completion.state !== "pending") {
    throw new Error("A managed, active SQL transaction is required.");
  }
  return () => {
    if (completion.state !== "committed") {
      throw new Error("The outer SQL transaction has not confirmed commit.");
    }
  };
}

type DatabaseLike = SqlExecutor & {
  __copilotzTransaction?: <T>(operation: () => Promise<T>) => Promise<T>;
  transaction?: <T>(
    operation: (transaction: SqlExecutor) => Promise<T>,
  ) => Promise<T>;
  listen?: SqlSession["listen"];
};

/** Adapts an Ominipg/Copilotz database into the narrow atomic-session seam. */
export function createSqlSession(database: DatabaseLike): SqlSession {
  const query: SqlExecutor["query"] = (sql, params) =>
    database.query(sql, params);
  const rawTransaction: SqlSession["transaction"] = async (operation) => {
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

  const transaction: SqlSession["transaction"] = (operation) =>
    runSqlTransaction({ transaction: rawTransaction }, operation);

  return {
    query,
    ...(typeof database.listen === "function"
      ? { listen: database.listen.bind(database) }
      : {}),
    transaction,
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
