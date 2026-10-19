import { assert, assertEquals, assertRejects } from "@std/assert";
import { createTestDatabase } from "../../testing/ominipg.ts";
import { createCopilotzApplication } from "../application.ts";
import { type ActionContext, defineAction } from "../../actions/index.ts";
import type { SqlSession } from "../../events/session.ts";

for (const mode of ["content", "policy", "content-policy"] as const) {
  Deno.test(`${mode} Action admission and authorized completion each commit lifecycle with delivery`, async () => {
    const db = await createTestDatabase({
      url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
    });
    const schema = `inline_atomic_${crypto.randomUUID().replaceAll("-", "")}`;
    let inspect = false;
    let failAdmission = false;
    let failSettlement = false;
    const snapshots: Array<
      {
        statuses: string[];
        deliveries: string[];
        receipts: number;
        head: number;
      }
    > = [];
    const session: SqlSession & { close(): Promise<void> } = {
      ...db,
      transaction: (run) =>
        db.transaction(async (tx) => {
          const result = await run({
            query(sql, params) {
              if (failAdmission && params?.includes("fixture.atomic.invoked")) {
                failAdmission = false;
                throw new Error("injected invoked failure");
              }
              if (
                failSettlement && sql.includes("lease_owner = NULL") &&
                params?.[1] === "succeeded"
              ) {
                failSettlement = false;
                throw new Error("injected settlement failure");
              }
              return tx.query(sql, params);
            },
          });
          if (inspect) {
            const statuses = (await tx.query<{ type: string }>(
              `SELECT type FROM "${schema}".events ORDER BY seq`,
            )).rows.map((r) => r.type);
            snapshots.push({
              statuses,
              deliveries: (await tx.query<{ status: string }>(
                `SELECT status FROM "${schema}".event_deliveries`,
              )).rows.map((r) => r.status),
              receipts:
                (await tx.query(`SELECT key FROM "${schema}".owner_receipts`))
                  .rows.length,
              head: Number(
                (await tx.query(
                  `SELECT last_seq FROM "${schema}".owner_epochs`,
                )).rows[0].last_seq,
              ),
            });
          }
          return result;
        }),
    };
    let calls = 0;
    const action = defineAction({
      id: "fixture.atomic",
      ...(mode.includes("content") ? { content: { input: ["parts"] } } : {}),
      execute(input: unknown, _context: ActionContext) {
        calls++;
        return input;
      },
    });
    const app = await createCopilotzApplication({
      database: session,
      databaseSchema: schema,
      namespace: "scope",
      actions: { echo: action },
      ...(mode.includes("policy")
        ? {
          authorization: {
            policies: {
              allow: {
                revision: "1",
                sources: [],
                evaluate: () => ({ actions: { echo: {} } }),
              },
            },
            actions: { echo: { id: "allow", revision: "1" } },
            collections: {},
          },
        }
        : {}),
    });
    try {
      inspect = true;
      failAdmission = true;
      await assertRejects(
        () =>
          app.host.actions.echo({ parts: "hello" }, { idempotencyKey: "same" }),
        Error,
        "injected invoked failure",
      );
      assertEquals(calls, 0);
      for (
        const table of [
          "events",
          "event_deliveries",
          "open_actions",
          "owner_receipts",
          "owner_deadlines",
        ]
      ) {
        assertEquals(
          (await db.query(`SELECT 1 FROM "${schema}".${table}`)).rows,
          [],
        );
      }
      assertEquals(
        Number(
          (await db.query(`SELECT last_seq FROM "${schema}".owner_epochs`))
            .rows[0].last_seq,
        ),
        0,
      );
      await app.host.actions.echo({ parts: "hello" }, {
        idempotencyKey: "same",
      });
      inspect = false;
      assertEquals(calls, 1);
      const admitted = snapshots.find((s) => s.deliveries.includes("leased"));
      assert(admitted);
      assert(admitted.statuses.includes("fixture.atomic.invoked"));
      if (mode.includes("policy")) assert(admitted.receipts > 0);
      const completed = snapshots.find((s) =>
        s.statuses.includes("fixture.atomic.completed")
      );
      assert(completed);
      assertEquals(completed.deliveries, ["succeeded"]);
      assertEquals(
        completed.statuses.filter((s) => s === "fixture.atomic.completed")
          .length,
        1,
      );
      assertEquals(completed.head, completed.statuses.length);
      assertEquals(
        (await db.query(
          `SELECT state FROM "${schema}".open_actions WHERE state IN ('invoked','awaiting')`,
        )).rows,
        [],
      );
      // A fault after terminal insertion must roll that terminal back with its
      // settlement. The subsequent failure terminal is the only durable winner.
      inspect = true;
      failSettlement = true;
      await assertRejects(() =>
        app.host.actions.echo({ parts: "hello" }, {
          idempotencyKey: "settlement-fault",
        })
      );
      assertEquals(failSettlement, false);
      const terminalCounts = (await db.query<{ type: string; count: string }>(
        `SELECT type,count(*)::text AS count FROM "${schema}".events WHERE type IN ('fixture.atomic.completed','fixture.atomic.failed') GROUP BY type ORDER BY type`,
      )).rows;
      assertEquals(terminalCounts, [{
        type: "fixture.atomic.completed",
        count: "1",
      }, { type: "fixture.atomic.failed", count: "1" }]);
      assertEquals(
        (await db.query<{ status: string }>(
          `SELECT status FROM "${schema}".event_deliveries`,
        )).rows.map((r) => r.status),
        ["succeeded", "succeeded"],
      );
    } finally {
      inspect = false;
      await app.shutdown();
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.close();
    }
  });
}
