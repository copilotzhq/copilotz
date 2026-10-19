import type { SqlExecutor } from "../events/session.ts";
import {
  type AuthorityUpgradeManifest,
  inspectAuthorityUpgrade,
} from "../authorization/upgrade.ts";
import { retainedInvocationDigest } from "../authorization/migration.ts";
import { testAuthority } from "./authority.ts";
import { testSecretAdapter } from "./secret-adapter.ts";

/** Fixture-only policy and explicit historical bindings; never an operator default. */
export async function testAuthorityManifest(
  db: SqlExecutor,
  schema: string,
): Promise<AuthorityUpgradeManifest> {
  const inventory = await inspectAuthorityUpgrade(db, schema);
  return {
    policies: [{ id: "fixture", revision: "1" }],
    actionSchemas: Object.fromEntries(
      inventory.invocations.map((entry) => [entry.actionId, null]),
    ),
    invocations: await Promise.all(inventory.invocations.map(async (entry) => ({
      databaseSchema: schema,
      namespace: entry.namespace,
      runId: entry.runId,
      expectedDigest: await retainedInvocationDigest(entry),
      authority: {
        ...testAuthority(schema, entry.namespace),
        provenance: {
          ingress: "core" as const,
          source: entry.sourceEventId,
          ...(entry.parentRunId ? { parent: entry.parentRunId } : {}),
        },
      },
    }))),
    events: inventory.events.map((entry) => ({
      ...entry,
      authority: testAuthority(schema, entry.namespace),
      ...(entry.unclassified ? { ingress: { kind: "host" as const } } : {}),
    })),
  };
}
export async function testUpgradeOptions(db: SqlExecutor, schema: string) {
  const adapter = await testSecretAdapter();
  return {
    ownerKeys: { sourceAdapter: adapter, masterAdapter: adapter },
    authority: await testAuthorityManifest(db, schema),
  };
}
