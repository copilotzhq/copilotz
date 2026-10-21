import { bindSqlDatabaseIdentity } from "./database-identity.ts";
import { createEventStoreError } from "./errors.ts";
import { retainReadSnapshotKind } from "./snapshot-kind.ts";

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

/** Cleanup is confirmed only after the backend has released the exact resource. */
export type SqlSnapshotCleanup = "confirmed" | "unknown";
export type SqlReadSnapshot =
  | Readonly<{ kind: "exclusive"; snapshot: SqlExecutor }>
  | Readonly<
    {
      kind: "pooled";
      snapshot: SqlExecutor;
      current<T>(
        operation: (transaction: SqlExecutor) => Promise<T>,
      ): Promise<T>;
    }
  >;

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
  withReadSnapshot?<T>(
    operation: (scope: SqlReadSnapshot) => Promise<T>,
    options?: Readonly<
      {
        signal?: AbortSignal;
        onCleanup?: (outcome: SqlSnapshotCleanup) => void;
      }
    >,
  ): Promise<T>;
};

type TransactionCompletion = {
  state: "pending" | "committed" | "failed";
  callbacks: Array<() => void>;
  active: boolean;
  settled: Array<() => void>;
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
  const completion: TransactionCompletion = {
    state: "pending",
    callbacks: [],
    settled: [],
    active: false,
  };
  let active = false;
  try {
    const result = await session.transaction(async (executor) => {
      active = true;
      completion.active = true;
      const transaction: SqlExecutor = {
        query(sql, params) {
          if (!active) {
            return Promise.reject(new Error("SQL transaction is closed."));
          }
          return executor.query(sql, params);
        },
      };
      bindSqlDatabaseIdentity(transaction, session);
      completions.set(transaction, completion);
      try {
        return await operation(transaction);
      } finally {
        active = false;
        completion.active = false;
      }
    });
    completion.state = "committed";
    for (const callback of completion.callbacks.splice(0)) callback();
    return result;
  } catch (error) {
    if (completion.state !== "committed") completion.state = "failed";
    completion.callbacks.length = 0;
    throw error;
  } finally {
    for (const callback of completion.settled.splice(0)) callback();
  }
}

/** A command has a revocable facade and output gate. Only groups need savepoints. */
export async function runSqlCommandScope<T>(
  parent: SqlExecutor,
  operation: (transaction: SqlExecutor) => Promise<T>,
  savepoint: boolean,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  const gate = sqlCommitGate(parent);
  const completion: TransactionCompletion = {
    state: "pending",
    callbacks: [],
    settled: [],
    active: true,
  };
  let active = true;
  let queryFailed = false;
  let queryError: unknown;
  const transaction: SqlExecutor = {
    query<TRow extends Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ) {
      if (!active) return Promise.reject(new Error("SQL command is closed."));
      if (
        /^\s*(?:BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE|PREPARE\s+TRANSACTION)\b/i
          .test(sql)
      ) {
        return Promise.reject(
          new Error("Command handlers cannot control transactions."),
        );
      }
      return parent.query<TRow>(sql, params).catch((error) => {
        // Catching a SQL exception in the handler does not clear PostgreSQL's
        // aborted transaction. COMMIT would otherwise report a silent rollback
        // for a singleton without a receipt or another statement to detect it.
        if (!queryFailed) queryError = error;
        queryFailed = true;
        throw error;
      });
    },
  };
  bindSqlDatabaseIdentity(transaction, parent);
  completions.set(transaction, completion);
  afterSqlSettlement(parent, () => {
    for (const callback of completion.settled.splice(0)) callback();
  });
  if (savepoint) await parent.query("SAVEPOINT owner_command");
  let value: T;
  try {
    value = await operation(transaction);
    if (queryFailed) throw queryError;
  } catch (error) {
    completion.state = "failed";
    completion.callbacks.length = 0;
    if (!savepoint) throw error;
    await parent.query("ROLLBACK TO SAVEPOINT owner_command");
    await parent.query("RELEASE SAVEPOINT owner_command");
    return { ok: false, error };
  } finally {
    active = false;
    completion.active = false;
  }
  if (savepoint) await parent.query("RELEASE SAVEPOINT owner_command");
  afterSqlCommit(parent, () => {
    gate();
    completion.state = "committed";
    for (const callback of completion.callbacks.splice(0)) callback();
  });
  return { ok: true, value };
}

/** Internal aliases share the outer transaction's commit and rollback gates. */
export function bindSqlTransactionAlias(
  alias: SqlExecutor,
  source: SqlExecutor,
): void {
  sqlCommitGate(source);
  bindSqlDatabaseIdentity(alias, source);
  completions.set(alias, completions.get(source)!);
}
/** Retain joined owners until the physical transaction settles, including rollback. */
export function afterSqlSettlement(
  transaction: SqlExecutor,
  callback: () => void,
): void {
  sqlCommitGate(transaction);
  completions.get(transaction)!.settled.push(callback);
}

/** Registers an internal synchronous cache update at the outer commit gate. */
export function afterSqlCommit(
  transaction: SqlExecutor,
  callback: () => void,
): void {
  const completion = completions.get(transaction);
  if (!completion || completion.state !== "pending" || !completion.active) {
    throw new Error("A managed, active SQL transaction is required.");
  }
  completion.callbacks.push(callback);
}

/** Captures the transaction's output gate without retaining its SQL executor. */
export function sqlCommitGate(transaction: SqlExecutor): () => void {
  const completion = completions.get(transaction);
  if (!completion || completion.state !== "pending" || !completion.active) {
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
  withReadSnapshot?: SqlSession["withReadSnapshot"];
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

  const atomic = bindSqlDatabaseIdentity(
    { transaction: rawTransaction },
    database,
  );
  const transaction: SqlSession["transaction"] = (operation) =>
    runSqlTransaction(atomic, operation);

  const withReadSnapshot = typeof database.withReadSnapshot === "function"
    ? database.withReadSnapshot.bind(database)
    : undefined;
  if (withReadSnapshot) {
    retainReadSnapshotKind(withReadSnapshot, database.withReadSnapshot!);
  }
  return bindSqlDatabaseIdentity({
    query,
    ...(withReadSnapshot ? { withReadSnapshot } : {}),
    transaction,
    async readSnapshot(operation) {
      return await transaction(async (snapshot) => {
        await snapshot.query(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
        );
        return await operation(snapshot);
      });
    },
  }, database);
}
