import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { provisionCopilotzSchema } from "../events/index.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import {
  createOperationCatalog,
  OPERATION_CATALOG_FINGERPRINT,
  provisionOperationCatalog,
  upgradeOperationCatalog,
  validateOperationCatalog,
} from "./catalog.ts";
import { createStreamOutputDescriptor } from "./observation.ts";
import { streamErrorOutput } from "./terminal.ts";

const POSTGRES_URL = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL")?.trim();
const descriptor = (id: string) =>
  createStreamOutputDescriptor({
    id,
    semanticId: id,
    mediaType: "text/plain",
    kind: "text",
    role: "assistant",
    metadata: {},
  }, { namespace: "scope" });

async function migration(url: string) {
  const db = await createTestDatabase({ url });
  const schema = `stream_taxonomy_${crypto.randomUUID().replaceAll("-", "")}`;
  try {
    await provisionCopilotzSchema(db, schema);
    const tables = await provisionOperationCatalog(db, schema);
    // Restore the previous catalog layout, including its actual constraints.
    await db.query(`ALTER TABLE ${tables.operationStreams}
      DROP CONSTRAINT copilotz_operation_streams_terminal_check,
      DROP CONSTRAINT copilotz_operation_streams_outcome_check,
      DROP CONSTRAINT copilotz_operation_streams_availability_check,
      DROP COLUMN reason, DROP COLUMN availability_reason, DROP COLUMN cleanup_state,
      ADD COLUMN capture TEXT CONSTRAINT copilotz_operation_streams_capture_check
        CHECK (capture IN ('complete','truncated')),
      ADD CONSTRAINT copilotz_operation_streams_outcome_check
        CHECK (outcome IN ('completed','failed','cancelled','superseded','abandoned')),
      ADD CONSTRAINT copilotz_operation_streams_availability_check
        CHECK (availability IN ('retained','purge_pending','purged','missing')),
      ADD CONSTRAINT copilotz_operation_streams_terminal_check CHECK (
        (state = 'open' AND outcome IS NULL AND capture IS NULL
          AND terminal_at IS NULL AND availability = 'retained')
        OR (state = 'terminating' AND outcome IS NOT NULL AND capture IS NOT NULL
          AND terminal_at IS NULL AND availability = 'retained'
          AND (outcome <> 'completed' OR capture = 'complete'))
        OR (state = 'terminal' AND outcome IS NOT NULL AND capture IS NOT NULL
          AND terminal_at IS NOT NULL
          AND (outcome <> 'completed' OR capture = 'complete')
          AND (asset_retention <> 'canonical' OR outcome = 'completed'))
      )`);
    await db.query(`ALTER TABLE ${tables.metadata}
      DROP CONSTRAINT copilotz_operation_catalog_metadata_fingerprint_check`);
    await db.query(
      `UPDATE ${tables.metadata} SET fingerprint = 'action-obligations-v1'`,
    );
    await db.query(`ALTER TABLE ${tables.metadata}
      ADD CONSTRAINT copilotz_operation_catalog_metadata_fingerprint_check
      CHECK (fingerprint = 'action-obligations-v1')`);
    const cases = [
      ["open", null, "retained", null],
      ["terminating", "superseded", "retained", "truncated"],
      ["terminating", "abandoned", "retained", "truncated"],
      ["terminal", "superseded", "retained", "truncated"],
      ["terminal", "abandoned", "retained", "truncated"],
      ["terminal", "failed", "retained", "complete"],
      ["terminal", "cancelled", "retained", "truncated"],
      ["terminal", "completed", "retained", "complete"],
      ["terminal", "completed", "purge_pending", "complete"],
      ["terminal", "completed", "missing", "complete"],
      ["terminal", "completed", "purged", "complete"],
      ["terminal", "superseded", "missing", "truncated"],
      ["terminal", "abandoned", "purge_pending", "truncated"],
      ["terminal", "completed", "retained", "complete"],
      ["terminal", "completed", "purge_pending", "complete"],
      ["terminal", "completed", "missing", "complete"],
    ] as const;
    for (
      const [i, [state, outcome, availability, capture]] of cases.entries()
    ) {
      await db.query(
        `INSERT INTO ${tables.operationStreams}
        (namespace, operation_id, stream_id, semantic_stream_id, stream_ordinal,
         body_id, descriptor, state, outcome, availability, capture,
         committed_offset, digest, asset_retention, asset_id, terminal_at, created_at, updated_at)
        VALUES ('scope','operation',$1,$1,$2,$1,$3::jsonb,$4,$5,$6,$7,7,$8,
          $9,$10,CASE WHEN $4 = 'terminal' THEN '2026-10-01T00:00:00Z'::timestamptz END,
          '2026-10-01T00:00:00Z','2026-10-01T00:00:00Z')`,
        [
          String(i),
          i + 1,
          JSON.stringify(descriptor(String(i))),
          state,
          outcome,
          availability,
          capture,
          `sha256:${"a".repeat(64)}`,
          i >= 13 ? "canonical" : "observation",
          i >= 13 ? `asset-${i}` : null,
        ],
      );
    }
    const before = (await db.query(
      `SELECT * FROM ${tables.operationStreams} ORDER BY stream_ordinal`,
    )).rows;
    await assertRejects(
      () => provisionOperationCatalog(db, schema),
      Error,
      "offline upgrade",
    );
    await assertRejects(() => validateOperationCatalog(db, schema));
    // A failed upgrade rolls back both data conversion and constraint changes.
    await assertRejects(
      () =>
        upgradeOperationCatalog({
          ...db,
          transaction: (work) =>
            db.transaction((tx) =>
              work({
                async query(sql, parameters) {
                  const result = await tx.query(sql, parameters);
                  if (
                    sql.includes("DROP COLUMN IF EXISTS capture")
                  ) throw new Error("upgrade interrupted");
                  return result as never;
                },
              })
            ),
        }, schema),
      Error,
      "upgrade interrupted",
    );
    assertEquals(
      (await db.query(
        `SELECT * FROM ${tables.operationStreams} ORDER BY stream_ordinal`,
      )).rows,
      before,
    );
    await upgradeOperationCatalog(db, schema);
    await validateOperationCatalog(db, schema);
    const catalog = createOperationCatalog(db, schema);
    const rows = await catalog.listStreams({
      namespace: "scope",
      operationId: "operation",
    });
    for (const [i, [state, outcome, availability]] of cases.entries()) {
      const row = rows[i];
      assertEquals(row.state, state);
      assertEquals(
        row.outcome,
        outcome === "superseded"
          ? "cancelled"
          : outcome === "abandoned"
          ? "failed"
          : outcome ?? undefined,
      );
      assertEquals(
        row.reason,
        outcome === "superseded" || outcome === "abandoned"
          ? outcome
          : undefined,
      );
      assertEquals(
        row.availability,
        availability === "purge_pending"
          ? "retained"
          : availability === "missing"
          ? "purged"
          : availability,
      );
      assertEquals(
        row.availabilityReason,
        availability === "missing"
          ? "missing"
          : availability === "purged"
          ? "deleted"
          : undefined,
      );
      assertEquals(
        row.cleanupState,
        availability === "purge_pending" ? "pending" : undefined,
      );
      assertEquals(row.retention, i >= 13 ? "canonical" : "observation");
      assertEquals(row.assetId, i >= 13 ? `asset-${i}` : undefined);
      assertEquals(row.committedOffset, 7);
      assertEquals(row.streamOrdinal, String(i + 1));
      assertEquals(row.replayKey, String(before[i].replay_key));
      assertEquals(row.bodyId, String(i));
      assertEquals(row.digest, `sha256:${"a".repeat(64)}`);
      assertEquals(row.createdAt, "2026-10-01T00:00:00.000Z");
      assertEquals(row.updatedAt, row.createdAt);
      assertEquals(
        row.terminalAt,
        state === "terminal" ? row.createdAt : undefined,
      );
      assertEquals(Object.hasOwn(row, "capture"), false);
    }
    await upgradeOperationCatalog(db, schema);
    assertEquals(
      await catalog.listStreams({
        namespace: "scope",
        operationId: "operation",
      }),
      rows,
    );
    assertEquals(
      (await db.query(`SELECT fingerprint FROM ${tables.metadata}`)).rows[0]
        .fingerprint,
      OPERATION_CATALOG_FINGERPRINT,
    );
    for (
      const assignment of [
        "outcome = 'abandoned'",
        "outcome = 'superseded'",
        "availability = 'missing'",
        "availability = 'purge_pending'",
        "cleanup_state = 'pending', availability = 'purged'",
      ]
    ) {
      await assertRejects(() =>
        db.query(
          `UPDATE ${tables.operationStreams} SET ${assignment} WHERE stream_id = '7'`,
        )
      );
    }
    await assertRejects(() =>
      db.query(`SELECT capture FROM ${tables.operationStreams}`)
    );
  } finally {
    await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.close();
  }
}

Deno.test("stream taxonomy upgrades existing rows by cause atomically", () =>
  migration(":memory:"));
Deno.test({
  name: "PostgreSQL stream taxonomy upgrades existing rows by cause atomically",
  ignore: !POSTGRES_URL,
  fn: () => migration(POSTGRES_URL!),
});

Deno.test("missing bytes preserve terminal outcomes and cleanup cannot resurrect them", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const schema = "stream_terminal_causes";
  try {
    await provisionCopilotzSchema(db, schema);
    await provisionOperationCatalog(db, schema);
    const catalog = createOperationCatalog(db, schema);
    await db.transaction((tx) =>
      catalog.indexEvent(tx, {
        namespace: "scope",
        operationId: "operation",
        eventId: "operation",
        position: "1",
        correlationId: "operation",
        createdAt: "2026-10-01T00:00:00Z",
      })
    );
    for (const outcome of ["completed", "failed", "cancelled"] as const) {
      const target = {
        namespace: "scope",
        operationId: "operation",
        streamId: outcome,
      };
      const body = {
        bodyId: outcome,
        byteLength: 7,
        mediaType: "text/plain",
        digest: `sha256:${"a".repeat(64)}` as const,
        maintenanceVersion: 1,
      };
      assertExists(
        await catalog.openStream({
          ...target,
          semanticStreamId: outcome,
          bodyId: outcome,
          descriptor: descriptor(outcome),
        }),
      );
      assertEquals(
        outcome === "completed"
          ? await catalog.sealStream({
            ...target,
            body: { ...body, state: "ready" },
          })
          : await catalog.terminateStream({
            ...target,
            outcome,
            reason: "provider_error",
            body: { ...body, state: "incomplete" },
          }),
        true,
      );
      const before = await catalog.waitForStreamTerminal("scope", outcome);
      assertEquals(await catalog.beginStreamCleanup(target), true);
      assertEquals(
        (await catalog.waitForStreamTerminal("scope", outcome)).availability,
        "retained",
      );
      assertEquals(
        await catalog.markStreamUnavailable({
          ...target,
          outcome: "failed",
          reason: "abandoned",
          availabilityReason: "missing",
        }),
        true,
      );
      const after = await catalog.waitForStreamTerminal("scope", outcome);
      assertEquals(after, {
        ...before,
        availability: "purged",
        availabilityReason: "missing",
      });
      assertEquals(
        streamErrorOutput(outcome, after)?.code,
        "stream_unavailable",
      );
      assertEquals(
        await catalog.sealStream({
          ...target,
          body: { ...body, state: "ready" },
        }),
        false,
      );
      assertEquals(
        await catalog.terminateStream({
          ...target,
          outcome: "failed",
          body: { ...body, state: "incomplete" },
        }),
        false,
      );
      assertEquals(await catalog.beginStreamCleanup(target), false);
      assertEquals(await catalog.pruneStream(target), false);
      assertEquals(
        await catalog.waitForStreamTerminal("scope", outcome),
        after,
      );
    }
  } finally {
    await db.close();
  }
});

Deno.test("completion requires a full sealed body and an unaccepted seal can fail with its prefix", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const schema = "stream_completion";
  try {
    await provisionCopilotzSchema(db, schema);
    await provisionOperationCatalog(db, schema);
    const catalog = createOperationCatalog(db, schema);
    await db.transaction((tx) =>
      catalog.indexEvent(tx, {
        namespace: "scope",
        operationId: "operation",
        eventId: "operation",
        position: "1",
        correlationId: "operation",
        createdAt: "2026-10-01T00:00:00Z",
      })
    );
    const target = {
      namespace: "scope",
      operationId: "operation",
      streamId: "lane",
    };
    await catalog.openStream({
      ...target,
      semanticStreamId: "lane",
      bodyId: "lane",
      descriptor: descriptor("lane"),
    });
    await catalog.commitStreamOffset({ ...target, committedOffset: 7 });
    const body = {
      bodyId: "lane",
      state: "ready" as const,
      byteLength: 7,
      mediaType: "text/plain",
      digest: `sha256:${"a".repeat(64)}` as const,
      maintenanceVersion: 1,
    };
    await assertRejects(
      () =>
        catalog.sealStream({
          ...target,
          body: { ...body, state: "incomplete" } as never,
        }),
      TypeError,
      "sealed Body",
    );
    assertEquals(
      await catalog.sealStream({ ...target, body: { ...body, byteLength: 6 } }),
      false,
    );
    assertEquals(
      (await catalog.getStream("scope", "operation", "lane"))?.state,
      "open",
    );
    assertEquals(
      await catalog.beginStreamTerminalization({
        ...target,
        outcome: "completed",
      }),
      true,
    );
    assertEquals(
      await catalog.terminateStream({
        ...target,
        outcome: "failed",
        reason: "abandoned",
        body: { ...body, state: "incomplete" },
      }),
      true,
    );
    const failed = await catalog.waitForStreamTerminal("scope", "lane");
    assertEquals(failed.outcome, "failed");
    assertEquals(failed.reason, "abandoned");
    assertEquals(failed.offset, 7);
    assertEquals(failed.availability, "retained");
    assertEquals(await catalog.sealStream({ ...target, body }), false);
  } finally {
    await db.close();
  }
});
