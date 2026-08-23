import { Ominipg } from "../../dependencies/ominipg.ts";
import type { OminipgConnectionOptions } from "../../dependencies/ominipg.ts";
import { resolveAutoProviders } from "../../dependencies/ominipg-auto.ts";
import { createSqlSession, type SqlSession } from "../events/index.ts";

type QueryResult<TRow extends Record<string, unknown>> = Readonly<{
  rows: TRow[];
  rowCount?: number;
}>;

type Query = <TRow extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
) => Promise<QueryResult<TRow>>;

export type OminipgDatabaseLike = Readonly<{
  query: Query;
  transaction<T>(
    operation: (transaction: Readonly<{ query: Query }>) => T | Promise<T>,
  ): Promise<T>;
  close(): Promise<void>;
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
  requestTimeoutMs?: OminipgConnectionOptions["requestTimeoutMs"];
  logMetrics?: boolean;
}>;

export type ManagedOminipgDatabase = Readonly<{
  database: OminipgDatabaseLike;
  session: SqlSession;
  close(): Promise<void>;
}>;

/**
 * Adapts one Ominipg connection to Copilotz's narrow atomic SQL seam.
 *
 * Ominipg owns transaction pinning and operation ordering. Copilotz only
 * narrows that database contract to the atomic SQL seam used by its stores.
 */
export function createOminipgSqlSession(
  database: OminipgDatabaseLike,
): SqlSession {
  return Object.freeze(createSqlSession(database));
}

/** Opens an application-owned Ominipg database and its private SQL adapter. */
export async function openManagedOminipgDatabase(
  options: CopilotzOminipgOptions = {},
): Promise<ManagedOminipgDatabase> {
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
    ...(options.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.requestTimeoutMs }),
    ...(options.logMetrics === undefined
      ? {}
      : { logMetrics: options.logMetrics }),
    // Copilotz execution isolation belongs to Oxian. Do not create a second
    // legacy Web Worker boundary around the persistence connection.
    useWorker: false,
  });
  const adapted = database as unknown as OminipgDatabaseLike;
  const session = createOminipgSqlSession(adapted);
  let closeTask: Promise<void> | undefined;
  return Object.freeze({
    database: adapted,
    session,
    close() {
      closeTask ??= database.close();
      return closeTask;
    },
  });
}
