import {
  type CopilotzOminipgOptions,
  type OminipgDatabaseLike,
  openManagedOminipgDatabase,
} from "../adapters/ominipg.ts";
import { createOminipgSqlSession } from "../adapters/ominipg.ts";
import type { SqlSession } from "../events/index.ts";

export type CopilotzDatabase = OminipgDatabaseLike;
export type CopilotzDatabaseInput = CopilotzOminipgOptions | CopilotzDatabase;

export type CopilotzPersistenceOptions = Readonly<{
  /** Database configuration or an application-owned Ominipg instance. */
  database?: CopilotzDatabaseInput;
}>;

export type OpenCopilotzPersistence = Readonly<{
  database: CopilotzDatabase;
  session: SqlSession;
  ownership: "application" | "injected";
  close(reason?: string): Promise<void>;
}>;

function isDatabase(value: CopilotzDatabaseInput): value is CopilotzDatabase {
  const candidate = value as Partial<CopilotzDatabase>;
  return typeof candidate.query === "function" &&
    typeof candidate.transaction === "function" &&
    typeof candidate.close === "function";
}

/** Resolves one role's explicit persistence ownership without host globals. */
export async function openCopilotzPersistence(
  options: CopilotzPersistenceOptions,
): Promise<OpenCopilotzPersistence> {
  if (options.database && isDatabase(options.database)) {
    return Object.freeze({
      database: options.database,
      session: createOminipgSqlSession(options.database),
      ownership: "injected",
      close: () => Promise.resolve(),
    });
  }

  const managed = await openManagedOminipgDatabase(options.database);
  return Object.freeze({
    database: managed.database,
    session: managed.session,
    ownership: "application",
    close: () => managed.close(),
  });
}
