import { Ominipg } from "../../dependencies/ominipg.ts";
import type { OminipgConnectionOptions } from "../../dependencies/ominipg.ts";
import { resolveAutoProviders } from "../../dependencies/ominipg-auto.ts";
import type { SqlExecutor, SqlSession } from "../events/index.ts";

type QueryResult<TRow extends Record<string, unknown>> = Readonly<{
  rows: TRow[];
  rowCount?: number;
}>;

type Query = <TRow extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
) => Promise<QueryResult<TRow>>;

type PoolClient = Readonly<{
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: unknown[]; rowCount?: number }>;
  release(): void;
}>;

type OminipgPool = Readonly<{
  connect(): Promise<PoolClient>;
}>;

export type OminipgDatabaseLike = Readonly<{
  query: Query;
  close(): Promise<void>;
  /** Ominipg exposes its direct PostgreSQL pool to integration adapters. */
  pool?: OminipgPool;
}>;

export type CopilotzOminipgOptions = Readonly<{
  /** Defaults to a private in-memory PGlite database. */
  url?: string;
  syncUrl?: string;
  pgliteExtensions?: string[];
  pgliteConfig?: OminipgConnectionOptions["pgliteConfig"];
  pgliteMemoryProfile?: OminipgConnectionOptions["pgliteMemoryProfile"];
  pgliteProvider?: OminipgConnectionOptions["pgliteProvider"];
  pgProvider?: OminipgConnectionOptions["pgProvider"];
  pgPoolMax?: number;
  logMetrics?: boolean;
}>;

export type ManagedSqlSession = Readonly<{
  session: SqlSession;
  close(): Promise<void>;
}>;

function createExclusiveRunner() {
  let tail: Promise<void> = Promise.resolve();
  return async function runExclusive<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = tail;
    let release: () => void = () => undefined;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };
}

function clientExecutor(client: PoolClient): SqlExecutor {
  return {
    async query<TRow extends Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ) {
      const result = await client.query(sql, params);
      return {
        rows: result.rows as TRow[],
        ...(result.rowCount === undefined ? {} : { rowCount: result.rowCount }),
      };
    },
  };
}

/**
 * Adapts one Ominipg connection to Copilotz's narrow atomic SQL seam.
 *
 * PGlite/worker operations are serialized so ordinary queries cannot interleave
 * with a transaction. Direct PostgreSQL transactions pin one pool client.
 */
export function createOminipgSqlSession(
  database: OminipgDatabaseLike,
): SqlSession {
  const runExclusive = createExclusiveRunner();
  const directQuery: Query = database.query.bind(database);
  const pool = database.pool;
  const query: SqlSession["query"] = async (sql, params) => {
    if (pool) return await directQuery(sql, params);
    return await runExclusive(() => directQuery(sql, params));
  };

  return Object.freeze({
    query,
    async transaction<T>(
      operation: (transaction: SqlExecutor) => Promise<T>,
    ): Promise<T> {
      if (pool) {
        const client = await pool.connect();
        const transaction = clientExecutor(client);
        try {
          await client.query("BEGIN");
          const result = await operation(transaction);
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      }

      return await runExclusive(async () => {
        const transaction: SqlExecutor = { query: directQuery };
        try {
          await directQuery("BEGIN");
          const result = await operation(transaction);
          await directQuery("COMMIT");
          return result;
        } catch (error) {
          await directQuery("ROLLBACK").catch(() => undefined);
          throw error;
        }
      });
    },
  });
}

/** Creates an application-owned Ominipg connection and atomic SQL session. */
export async function createManagedOminipgSession(
  options: CopilotzOminipgOptions = {},
): Promise<ManagedSqlSession> {
  const url = options.url ?? ":memory:";
  const providers = resolveAutoProviders({
    url,
    syncUrl: options.syncUrl,
    pgliteProvider: options.pgliteProvider,
    pgProvider: options.pgProvider,
  });
  const database = await Ominipg.connect({
    url,
    ...(options.syncUrl === undefined ? {} : { syncUrl: options.syncUrl }),
    ...providers,
    ...(options.pgliteExtensions === undefined
      ? {}
      : { pgliteExtensions: options.pgliteExtensions }),
    ...(options.pgliteConfig === undefined
      ? {}
      : { pgliteConfig: options.pgliteConfig }),
    ...(options.pgliteMemoryProfile === undefined
      ? {}
      : { pgliteMemoryProfile: options.pgliteMemoryProfile }),
    ...(options.pgPoolMax === undefined
      ? {}
      : { pgPoolMax: options.pgPoolMax }),
    ...(options.logMetrics === undefined
      ? {}
      : { logMetrics: options.logMetrics }),
    // Copilotz execution isolation belongs to Oxian. Do not create a second
    // legacy Web Worker boundary around the persistence connection.
    useWorker: false,
  });
  const session = createOminipgSqlSession(
    database as unknown as OminipgDatabaseLike,
  );
  let closeTask: Promise<void> | undefined;
  return Object.freeze({
    session,
    close() {
      closeTask ??= database.close();
      return closeTask;
    },
  });
}
