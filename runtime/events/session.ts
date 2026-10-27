import { readConfiguration } from "../persistence/read-limiter.ts";
import { bindSqlDatabaseIdentity } from "./database-identity.ts";
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

/** Applied by the adapter on BEGIN, so a snapshot costs no extra round trip. */
export type SqlTransactionOptions = Readonly<{
  isolation?: "read committed" | "repeatable read" | "serializable";
  readOnly?: boolean;
}>;

export type SqlSession = SqlExecutor & {
  transaction<T>(
    operation: (transaction: SqlExecutor) => Promise<T>,
    options?: SqlTransactionOptions,
  ): Promise<T>;
  /**
   * Runs a short, repeatable read-only database snapshot. The callback must
   * finish its selection before content or provider work begins.
   */
  concurrentReads?: boolean;
  readTransaction?<T>(
    operation: (snapshot: SqlExecutor) => Promise<T>,
    options?: import("../persistence/read-limiter.ts").ReadOptions,
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
  options?: SqlTransactionOptions,
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
    }, options);
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

/**
 * A command has a revocable facade and output gate. Only grouped commands need
 * a savepoint, and only once they issue SQL: it is set before the command's
 * first statement. It is never released; COMMIT releases them all, and
 * ROLLBACK TO targets the latest one, which is the failing command's.
 */
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
  let marked: Promise<void> | undefined;
  let markFailure: { error: unknown } | undefined;
  const mark = () =>
    marked ??= parent.query("SAVEPOINT owner_command").then(
      () => undefined,
      (error) => {
        markFailure = { error };
        throw error;
      },
    );
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
      const run = () => parent.query<TRow>(sql, params);
      return (savepoint ? mark().then(run) : run()).catch((error) => {
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
  let value: T;
  try {
    value = await operation(transaction);
    if (queryFailed) throw queryError;
  } catch (error) {
    completion.state = "failed";
    completion.callbacks.length = 0;
    if (!savepoint) throw error;
    if (marked) {
      // Without its rollback point the group cannot isolate this command.
      await marked.catch(() => undefined);
      if (markFailure) throw markFailure.error;
      await parent.query("ROLLBACK TO SAVEPOINT owner_command");
    }
    return { ok: false, error };
  } finally {
    active = false;
    completion.active = false;
  }
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

const SNAPSHOT: SqlTransactionOptions = Object.freeze({
  isolation: "repeatable read",
  readOnly: true,
});

type DatabaseLike = SqlExecutor & {
  transaction?: <T>(
    operation: (transaction: SqlExecutor) => Promise<T>,
    options?: SqlTransactionOptions,
  ) => Promise<T>;
};

/** Adapts an Ominipg/Copilotz database into the narrow atomic-session seam. */
export function createSqlSession(database: DatabaseLike): SqlSession {
  const query: SqlExecutor["query"] = (sql, params) =>
    database.query(sql, params);
  const rawTransaction: SqlSession["transaction"] = async (
    operation,
    options,
  ) => {
    if (typeof database.transaction === "function") {
      return await database.transaction(operation, options);
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
  const transaction: SqlSession["transaction"] = (operation, options) =>
    runSqlTransaction(atomic, operation, options);

  const config = readConfiguration(database);
  return bindSqlDatabaseIdentity({
    concurrentReads: config.concurrent,
    query,
    transaction,
    async readTransaction(operation, options) {
      return await config.limiter.run(
        () => transaction(operation, SNAPSHOT),
        options,
      );
    },
  }, database);
}
