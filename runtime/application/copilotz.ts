import { createManagedOminipgSession } from "../adapters/ominipg.ts";
import type { SqlSession } from "../events/index.ts";
import { createCopilotzApplication } from "./application.ts";
import type {
  CopilotzApplication,
  CreateCopilotzApplicationOptions,
} from "./types.ts";
import type { CopilotzOminipgOptions } from "../adapters/ominipg.ts";

export type CreateCopilotzOptions =
  & Omit<CreateCopilotzApplicationOptions, "session" | "closeSession">
  & Readonly<{
    /** Inject an application-owned atomic session. Mutually exclusive with database. */
    session?: SqlSession;
    /** Create a private Ominipg session. Defaults to an in-memory database. */
    database?: CopilotzOminipgOptions;
    /** Optional ownership callback for an injected session. */
    closeSession?: (reason?: string) => void | Promise<void>;
  }>;

/**
 * Creates the normal factory-first Copilotz application.
 *
 * With no session, Copilotz owns one private Ominipg connection. Injected
 * sessions and execution infrastructure remain application-owned unless an
 * explicit close callback grants ownership.
 */
export async function createCopilotz(
  options: CreateCopilotzOptions = {},
): Promise<CopilotzApplication> {
  if (options.session && options.database) {
    throw new TypeError("Use either session or database, not both.");
  }
  if (!options.session && options.closeSession) {
    throw new TypeError("closeSession requires an injected session.");
  }

  if (options.session) {
    return await createCopilotzApplication({
      ...options,
      session: options.session,
      ...(options.closeSession ? { closeSession: options.closeSession } : {}),
    });
  }

  const managed = await createManagedOminipgSession(options.database);
  try {
    return await createCopilotzApplication({
      ...options,
      session: managed.session,
      closeSession: () => managed.close(),
    });
  } catch (error) {
    await managed.close().catch(() => undefined);
    throw error;
  }
}
