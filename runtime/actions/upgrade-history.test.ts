import { assertEquals, assertRejects } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import { restoreRetainedFixture } from "../../scripts/fixtures/retained-upgrade/load.ts";
import { validateRetainedHistory } from "./upgrade-history.ts";
import { encodeEventBody } from "../events/body-store.ts";

Deno.test("batched retained history preserves terminal matching, nulls, namespaces and digest checks", async () => {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") || ":memory:",
  });
  const schema = `history_${crypto.randomUUID().replaceAll("-", "")}`;
  const q = `"${schema}"`;
  try {
    await restoreRetainedFixture(db, schema);
    for (
      const scenario of [
        {
          status: "completed",
          namespace: "archive",
          action: "check",
          run: "run",
          ok: true,
        },
        {
          status: "failed",
          namespace: "archive",
          action: "check",
          run: "run",
          ok: true,
        },
        {
          status: "cancelled",
          namespace: "archive",
          action: "check",
          run: "run",
          ok: true,
        },
        {
          status: "invoked",
          namespace: "archive",
          action: "check",
          run: "run",
          ok: false,
        },
        {
          status: "completed",
          namespace: "other",
          action: "check",
          run: "run",
          ok: false,
        },
        {
          status: "completed",
          namespace: "archive",
          action: "different",
          run: "run",
          ok: false,
        },
        {
          status: "completed",
          namespace: "archive",
          action: "check",
          run: "different",
          ok: false,
        },
        {
          status: "completed",
          namespace: "archive",
          action: null,
          run: "run",
          ok: false,
        },
        {
          status: "completed",
          namespace: "archive",
          action: "check",
          run: null,
          ok: false,
        },
      ]
    ) {
      await assertRejects(
        () =>
          db.transaction(async (tx) => {
            for (
              const [id, namespace, body] of [
                ["check-invoked", "archive", {
                  status: "invoked",
                  actionId: "check",
                  actionRunId: "run",
                }],
                ["check-terminal", scenario.namespace, {
                  status: scenario.status,
                  actionId: scenario.action,
                  actionRunId: scenario.run,
                }],
              ] as const
            ) {
              const encoded = await encodeEventBody(body);
              await tx.query(
                `INSERT INTO ${q}.event_bodies(namespace,event_body_id,schema_version,body,digest) VALUES($1,$2,1,$3::jsonb,$4)`,
                [namespace, id, encoded.body, encoded.digest],
              );
            }
            const legacy = await tx.query(
              `SELECT invoked.event_body_id FROM ${q}.event_bodies invoked WHERE invoked.body->>'status'='invoked' AND invoked.body->>'actionRunId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ${q}.event_bodies terminal WHERE terminal.namespace=invoked.namespace AND terminal.body->>'actionRunId'=invoked.body->>'actionRunId' AND terminal.body->>'actionId'=invoked.body->>'actionId' AND terminal.body->>'status' IN ('completed','failed','cancelled')) LIMIT 1`,
            );
            assertEquals(legacy.rows.length === 0, scenario.ok);
            if (scenario.ok) await validateRetainedHistory(tx, schema);
            else {await assertRejects(
                () => validateRetainedHistory(tx, schema),
                Error,
                "has no confirmed terminal",
              );}
            throw new Error("rollback scenario");
          }),
        Error,
        "rollback scenario",
      );
    }
    await db.transaction(async (tx) => {
      // The old reader trims JavaScript whitespace, including tabs and NBSP.
      await tx.query(
        `ALTER TABLE ${q}.events DISABLE TRIGGER copilotz_events_immutable`,
      );
      await tx.query(
        `UPDATE ${q}.events SET payload=jsonb_set(payload,'{dataRef,eventBodyId}',to_jsonb(E'\\t'||(payload->'dataRef'->>'eventBodyId')||chr(160))) WHERE payload ? 'dataRef'`,
      );
      await tx.query(
        `ALTER TABLE ${q}.events ENABLE TRIGGER copilotz_events_immutable`,
      );
      let reads = 0;
      await validateRetainedHistory({
        async query(sql, params) {
          if (sql.includes("SELECT b.namespace")) reads++;
          return await tx.query(sql, params);
        },
      }, schema);
      assertEquals(reads, 1);
    });
    await db.query(
      `UPDATE ${q}.event_bodies SET digest='sha256:bad' WHERE event_body_id=(SELECT event_body_id FROM ${q}.event_bodies LIMIT 1)`,
    );
    await assertRejects(
      () => validateRetainedHistory(db, schema),
      Error,
      "digest verification failed",
    );
  } finally {
    await db.query(`DROP SCHEMA ${q} CASCADE`);
    await db.close();
  }
});
