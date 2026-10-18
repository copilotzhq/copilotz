/** Owner-format fixture catalog. Unsupported stream recovery stays explicit. */
import type { ActionRecoveryCatalog } from "../actions/recovery.ts";
import type { SqlSession } from "../events/session.ts";
import {
  createOperationCatalogTables,
  createOwnerOperationCatalogCore,
} from "../streams/catalog.ts";

export function createTestOwnerCatalog(session: SqlSession, schema = "public") {
  const core = createOwnerOperationCatalogCore(session, schema);
  const tables = createOperationCatalogTables(schema);
  return Object.freeze(
    {
      ...core,
      async failDeliveryStreams(tx, input) {
        await core.assertFormat(tx);
        const result = await tx.query(
          `SELECT 1 FROM ${tables.operationStreams} WHERE operation_id=$1 LIMIT 1`,
          [input.operationId],
        );
        if (result.rows.length) {
          throw new Error(
            "Fixture content recovery unsupported.",
          );
        }
      },
    } satisfies typeof core & ActionRecoveryCatalog,
  );
}

/** Constraint-valid retained stream evidence for fail-closed owner tests. */
export async function insertTestOwnerStream(
  tx: import("../events/session.ts").SqlExecutor,
  scope: { namespace: string; operationId: string },
  options: {
    state?: "reserving" | "open" | "terminating" | "terminal";
    revocation?: "active" | "revoking" | "revoked";
  } = {},
) {
  const state = options.state ?? "reserving";
  const terminal = state === "terminal" || state === "terminating";
  const value = {
    namespace: scope.namespace,
    operation_id: scope.operationId,
    stream_ordinal: state === "reserving" ? null : 1,
    stream_id: "unsupported-stream",
    semantic_stream_id: "lane",
    body_id: "body",
    descriptor: {
      type: "stream.output",
      namespace: scope.namespace,
      streamId: "unsupported-stream",
    },
    owner_id: "owner",
    opening_owner_epoch: 1,
    delivery_attempt: 1,
    placement_binding: { placement: "owner-local", namespace: scope.namespace },
    physical_backend_id: "fixture",
    reservation_id: "reservation",
    writer_generation: 1,
    protection_deadline: "2099-01-01T00:00:00Z",
    revocation_state: options.revocation ??
      (state === "terminal" ? "revoked" : "active"),
    state,
    committed_offset: state === "reserving" ? 0 : 7,
    outcome: terminal ? "failed" : null,
    capture: terminal ? "truncated" : null,
    terminal_at: state === "terminal" ? "2099-01-01T00:00:00Z" : null,
  };
  const entries = Object.entries(value);
  await tx.query(
    `INSERT INTO public.copilotz_operation_streams (${
      entries.map(([key]) => key).join(",")
    }) VALUES (${entries.map((_, i) => `$${i + 1}`).join(",")})`,
    entries.map(([, v]) =>
      v !== null && typeof v === "object" ? JSON.stringify(v) : v
    ),
  );
}

/** Owner logical-body fixture; no physical bytes or domain adoption are implied. */
export async function insertTestOwnerBody(
  tx: import("../events/session.ts").SqlExecutor,
  scope: { namespace: string; operationId: string },
) {
  await tx.query(
    `INSERT INTO public.copilotz_operation_bodies
      (namespace,logical_body_id,owner_id,producer_operation_id,media_type,byte_length,digest,
       current_copy,pending_ref,pending_descriptor,protected_until,created_at,updated_at)
     VALUES($1,'logical-fixture','owner',$2,'text/plain',0,$3,$4::jsonb,'pending-fixture',$5::jsonb,$7,$6,$6)`,
    [
      scope.namespace,
      scope.operationId,
      "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      JSON.stringify({
        backendId: "fixture",
        key: "physical-fixture",
        versionToken: "version",
      }),
      JSON.stringify({
        kind: "text",
        role: "assistant",
        mediaType: "text/plain",
      }),
      "2026-10-18T00:00:00.000Z",
      "2026-10-19T00:00:00.000Z",
    ],
  );
}
