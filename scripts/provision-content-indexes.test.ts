import { assert, assertEquals, assertRejects } from "@std/assert";
import { provisionContentIndexes } from "./provision-content-indexes.ts";
import { provisionCopilotzSchema } from "../runtime/events/schema.ts";
import { createOwnerTestDatabase } from "../runtime/testing/owner-database.ts";

Deno.test("retained content index rollout preserves rows and prevents recovery table scans", async () => {
  const database = await createOwnerTestDatabase();
  const schema = "content_indexes";
  try {
    await provisionCopilotzSchema(database, schema);
    await database.query(`INSERT INTO "${schema}".content_logical_bodies
      (body_id,namespace,current_copy,writer_id,generation,protected_until,terminal)
      SELECT 'body-'||i,'tenant','copy-'||i,'writer',1,NOW()+INTERVAL '1 day','{}'::jsonb
      FROM generate_series(1,12000) i`);
    await database.query(
      `DROP INDEX "${schema}".content_logical_recovery_due_idx`,
    );
    const before = (await provisionContentIndexes(database, schema)).indexes;
    assert(
      !before.some((row) =>
        row.indexname === "content_logical_recovery_due_idx"
      ),
    );
    for (let i = 0; i < 2; i++) {
      const result = await provisionContentIndexes(database, schema, true);
      assert(
        result.indexes.some((row) =>
          row.indexname === "content_logical_recovery_due_idx"
        ),
      );
    }
    assertEquals(
      (await database.query(
        `SELECT count(*)::int AS n FROM "${schema}".content_logical_bodies`,
      )).rows[0].n,
      12000,
    );
    // Use the planner's normal settings and a realistically populated table.
    const explained = await database.query(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT COALESCE(recovery_after,protected_until) FROM "${schema}".content_logical_bodies
      WHERE terminal IS NULL ORDER BY COALESCE(recovery_after,protected_until) LIMIT 1`,
    );
    const plan = JSON.stringify(explained.rows);
    assert(plan.includes("content_logical_recovery_due_idx"), plan);
    assert(!plan.includes('"Node Type":"Seq Scan"'), plan);
    await assertRejects(() =>
      provisionContentIndexes(database, 'bad"schema', true)
    );
  } finally {
    await database.close();
  }
});
