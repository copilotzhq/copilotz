/** Synthetic accepted bodies for projection-only tests; byte guarantees use real stores. */
import { createContentCatalog } from "../content/catalog.ts";
import type { SqlSession } from "../events/session.ts";
export async function recordTestContentTerminal(
  session: SqlSession,
  schema: string,
  namespace: string,
  head: {
    bodyId: string;
    byteLength: number;
    digest: `sha256:${string}`;
    mediaType: string;
    versionToken?: string;
  },
  outcome: "completed" | "failed" | "cancelled" = "completed",
  reason?: string,
) {
  const catalog = createContentCatalog(session, schema),
    identity = {
      bodyId: head.bodyId,
      writerId: `fixture:${head.bodyId}`,
      generation: 1,
    };
  const current = await catalog.read(head.bodyId);
  if (current?.terminal) return;
  if (!current) {
    await catalog.reserve({
      ...identity,
      namespace,
      copy: {
        key: head.bodyId,
        backendKind: "memory",
        backendId: "fixture:projection",
      },
    });
  }
  await catalog.checkpoint({
    ...identity,
    expectedOffset: current?.committedOffset ?? 0,
    offset: head.byteLength,
  });
  if (outcome === "completed") {
    await catalog.sealIntent({
      ...identity,
      length: head.byteLength,
      digest: head.digest,
    });
    await catalog.sealAccepted({
      ...identity,
      head: {
        ...head,
        state: "ready",
        maintenanceVersion: 1,
        versionToken: head.versionToken ?? "fixture-version",
      },
    });
  } else {
    await catalog.beginRevocation(identity);
    await catalog.revoked(identity);
    await catalog.recordFailure({
      ...identity,
      outcome,
      ...(reason ? { reason } : {}),
    });
  }
}
