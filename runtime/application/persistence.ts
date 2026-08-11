import {
  type CopilotzOminipgOptions,
  createManagedOminipgSession,
} from "../adapters/ominipg.ts";
import type { SqlSession } from "../events/index.ts";

export type CopilotzPersistenceOptions = Readonly<{
  /** Inject an application-owned atomic session. Mutually exclusive with database. */
  session?: SqlSession;
  /** Create a private Ominipg session. Defaults to an in-memory database. */
  database?: CopilotzOminipgOptions;
  /** Optional ownership callback for an injected session. */
  closeSession?: (reason?: string) => void | Promise<void>;
}>;

export type OpenCopilotzPersistence = Readonly<{
  session: SqlSession;
  ownership: "application" | "injected";
  close(reason?: string): Promise<void>;
}>;

/** Resolves one role's explicit persistence ownership without host globals. */
export async function openCopilotzPersistence(
  options: CopilotzPersistenceOptions,
): Promise<OpenCopilotzPersistence> {
  if (options.session && options.database) {
    throw new TypeError("Use either session or database, not both.");
  }
  if (!options.session && options.closeSession) {
    throw new TypeError("closeSession requires an injected session.");
  }
  if (options.session) {
    return Object.freeze({
      session: options.session,
      ownership: options.closeSession ? "application" : "injected",
      async close(reason?: string) {
        await options.closeSession?.(reason);
      },
    });
  }

  const managed = await createManagedOminipgSession(options.database);
  return Object.freeze({
    session: managed.session,
    ownership: "application",
    close: () => managed.close(),
  });
}
