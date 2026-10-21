import type { SqlSession } from "../events/session.ts";
import type { SecretAdapter } from "../actions/secret-adapter.ts";
import { ensureOwnerDataKey } from "../actions/owner-data-key.ts";
import { provisionBodyStoreSchema } from "../content/body-store-schema.ts";
/**
 * Prepare storage and key binding together for an app's classified offline restore.
 * The core schema must already exist. To compose an atomic multi-schema restore,
 * pass a session facade whose transaction callback uses the outer transaction.
 * This only provisions offline tables and key binding; it never acquires an owner.
 */
export async function prepareRetainedDataRestore(input: {
  session: SqlSession;
  schema: string;
  adapter: SecretAdapter;
}): Promise<void> {
  await input.session.transaction(async (transaction) => {
    await provisionBodyStoreSchema(transaction, input.schema);
    await ensureOwnerDataKey(transaction, input.schema, input.adapter);
  });
}
