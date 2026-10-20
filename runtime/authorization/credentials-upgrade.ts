/** Offline v13 -> v14: credential effects and flow admission in one transaction. */
import type { SqlSession } from "../events/session.ts";
import { validateEventSchemaName } from "../events/schema.ts";
import { lockOwnerTables } from "../actions/owner-transfer-storage.ts";
import { authorizationSchemaStatements } from "./schema.ts";
import {
  assertRetainedDataDrained,
  inspectRetainedDataDrain,
} from "../actions/drain.ts";
export async function upgradeCredentialEffects(
  session: SqlSession,
  schemaName: string,
): Promise<void> {
  const schema = validateEventSchemaName(schemaName);
  await session.transaction(async (tx) => {
    await lockOwnerTables(tx, schema, "ACCESS EXCLUSIVE");
    const version = Number(
      (await tx.query<{ version: number }>(
        `SELECT version FROM "${schema}".copilotz_schema_metadata WHERE singleton`,
      )).rows[0]?.version,
    );
    if (version === 14) return;
    if (version !== 13) {
      throw new Error(
        "Credential effects upgrade requires schema version 13.",
      );
    }
    assertRetainedDataDrained(await inspectRetainedDataDrain(tx, schema));
    for (const statement of authorizationSchemaStatements(schema)) {
      await tx.query(statement);
    }
    await tx.query(
      `UPDATE "${schema}".owner_epochs SET epoch=epoch+1,holder=''`,
    );
    await tx.query(
      `UPDATE "${schema}".copilotz_schema_metadata SET version=14 WHERE singleton AND version=13`,
    );
  });
}
