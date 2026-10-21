import { bindSqlDatabaseIdentity } from "../events/database-identity.ts";
import {
  type CopilotzOminipgOptions,
  openManagedOminipgDatabase,
} from "@copilotz/copilotz/persistence";
import type { SqlSession } from "../events/index.ts";

/** Test-owned clean Ominipg database exposing the narrow SQL session seam. */
export type TestDatabase =
  & SqlSession
  & Readonly<{
    session: SqlSession;
    close(): Promise<void>;
  }>;

export async function createTestDatabase(
  options: CopilotzOminipgOptions = {},
): Promise<TestDatabase> {
  const managed = await openManagedOminipgDatabase(options);
  return bindSqlDatabaseIdentity(
    {
      session: managed.session,
      query: managed.session.query,
      transaction: managed.session.transaction,
      ...(managed.session.withReadSnapshot
        ? { withReadSnapshot: managed.session.withReadSnapshot }
        : {}),
      ...(managed.session.readSnapshot
        ? { readSnapshot: managed.session.readSnapshot }
        : {}),
      close: managed.close,
    } as const,
    managed.session,
  );
}
