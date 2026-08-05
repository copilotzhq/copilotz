import type { Ominipg } from "omnipg";

export type QueryResult<TRow extends Record<string, unknown>> = {
  rows: TRow[];
};

export interface SqlTransaction {
  query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<TRow>>;
}

/**
 * Ominipg transactions are pinned to a workload session. This queue prevents a
 * concurrent engine query from being inserted between BEGIN and COMMIT.
 */
export class DatabaseSession {
  readonly #db: Ominipg;
  #tail: Promise<void> = Promise.resolve();

  constructor(db: Ominipg) {
    this.#db = db;
  }

  query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<TRow>> {
    return this.#run(() => this.#db.query<TRow>(sql, params));
  }

  transaction<T>(
    callback: (transaction: SqlTransaction) => Promise<T>,
  ): Promise<T> {
    return this.#run(() => this.#db.transaction(callback));
  }

  close(): Promise<void> {
    return this.#run(() => this.#db.close());
  }

  #run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }
}
