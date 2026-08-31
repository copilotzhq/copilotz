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
};

/** Adapts an Ominipg/Copilotz database into the narrow atomic-session seam. */
export function createSqlSession(database: DatabaseLike): SqlSession {
  const query: SqlExecutor["query"] = (sql, params) =>
    database.query(sql, params);

  return {
    query,
    ...(typeof database.listen === "function"
      ? { listen: database.listen.bind(database) }
      : {}),
    async transaction(operation) {
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
    },
  };
}
