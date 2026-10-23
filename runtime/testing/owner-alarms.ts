import { openDatabaseOwner, releaseDatabaseOwner } from "../engine/commands.ts";
import type { SqlSession } from "../events/session.ts";
import type { CopilotzEngine } from "../engine/types.ts";

/** Advances an injected owner clock's due work and waits for the resulting scopes. */
export async function wakeOwnerAlarms(
  session: SqlSession,
  engine: CopilotzEngine,
  namespaces: readonly string[],
): Promise<void> {
  const owner = await openDatabaseOwner(session, engine.databaseSchema);
  try {
    await owner.wakeAlarms();
    const roots = (await Promise.all(namespaces.map((namespace) =>
      engine.events.list({ namespace })
    ))).flat();
    for (const root of roots) {
      for (let attempt = 0; attempt < 1000; attempt++) {
        const outstanding = await engine.events.outstanding(
          root.namespace,
          root.id,
        );
        if (!outstanding.unsettled) {
          break;
        }
        if (attempt === 999) {
          throw new Error(`Alarm work did not settle: ${root.id}`);
        }
        await new Promise((resolve) =>
          setTimeout(resolve, 5)
        );
      }
      await engine.execution.settleOutputs({
        namespace: root.namespace,
        settlementScopeId: root.id,
      });
    }
  } finally {
    await releaseDatabaseOwner(owner);
  }
}
