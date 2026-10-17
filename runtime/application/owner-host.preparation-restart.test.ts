/** Real public context restart: retained capture is structural evidence; root
 * replay uses current ingress permission, and only new live work invokes the
 * original-source/input guards. No old live parent is fabricated. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { eventually, fixture } from "./owner-host.preparation.fixture.test.ts";

const source = process.env.COPILOTZ_OXIAN_SOURCE_ROOT;
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function settled(f: Fixture) {
  await eventually(async () =>
    !(await f.query(
      "SELECT 1 FROM event_deliveries WHERE status NOT IN ('succeeded','dead_letter','cancelled')",
    )).rows.length &&
    !(await f.query(
      "SELECT 1 FROM copilotz_operations WHERE state NOT IN ('completed','failed','cancelled')",
    )).rows.length &&
    !(await f.query("SELECT 1 FROM owner_assignments WHERE NOT retired"))
      .rows.length &&
    !(await f.query("SELECT 1 FROM owner_alarms")).rows.length
  );
}
async function captured(f: Fixture) {
  return {
    prepared: (await f.query(
      "SELECT id,payload,metadata FROM events WHERE metadata ? 'preparation' ORDER BY id",
    )).rows,
    bodies: (await f.query(
      "SELECT namespace,event_body_id,body,digest FROM event_bodies ORDER BY namespace,event_body_id",
    )).rows,
    count: (await f.query("SELECT count(*)::int AS count FROM events")).rows[0]
      .count,
  };
}
function counters(f: Fixture) {
  return [
    f.state.rendered,
    f.state.mapped,
    f.state.projected,
    f.state.childExecuted,
    f.state.originalChecks,
  ];
}
for (const mode of ["in-process", "websocket"] as const) {
  test(
    `public ${mode} resumes closed prepared context with default budgets and current live authority`,
    { skip: !source, timeout: 60_000 },
    async () => {
      const f = await fixture(mode);
      try {
        const expected = ["child:first:original", "child:first:original"];
        assert.deepEqual(
          await f.remote.actions.parent("normal", {
            idempotencyKey: "captured",
          }),
          expected,
        );
        await settled(f);
        const claims = (await f.query<{ result: Record<string, unknown> }>(
          "SELECT result FROM owner_receipts WHERE kind='execution.claim'",
        )).rows;
        assert.equal(claims.length, 2);
        assert.ok(
          claims.every(({ result }) => !Object.hasOwn(result, "contract")),
          "default public host does not opt into lost-execution recovery",
        );
        const before = await captured(f), counts = counters(f);
        assert.equal(before.prepared.length, 1);
        assert.equal(
          (await f.query(
            "SELECT data->>'title' AS title FROM nodes WHERE id='normal'",
          )).rows[0].title,
          "changed",
        );
        f.state.originalAllowed = false;
        f.state.version = "replacement after shutdown";
        await f.restart(1);
        assert.deepEqual(
          counters(f),
          counts,
          "startup checks history without a fabricated source-policy caller",
        );
        assert.deepEqual(
          await captured(f),
          before,
          "restart preserves original prepared body, provenance and lifecycle",
        );
        assert.deepEqual(
          await f.remote.actions.parent("normal", {
            idempotencyKey: "captured",
          }),
          expected,
          "current authorized root terminal replay is independent of child hydration",
        );
        assert.deepEqual(counters(f), counts);
        assert.deepEqual(await captured(f), before);
        f.state.rootResultAllowed = false;
        await assert.rejects(f.remote.actions.parent("normal", {
          idempotencyKey: "captured",
        }));
        assert.deepEqual(counters(f), counts);
        f.state.rootResultAllowed = true;
        f.state.originalAllowed = true;
        f.state.recordId = "resumed-input";
        f.state.revokeChildInput = true;
        await assert.rejects(f.remote.actions.parent("resumed-input", {
          idempotencyKey: "fresh-after-resume",
        }));
        assert.equal(
          f.state.childExecuted,
          1,
          "new child's current original-input refusal prevents execution",
        );
        assert.ok(
          f.state.originalChecks > counts[4],
          "genuine new parent invokes the installed original-reference guard",
        );
      } finally {
        await f.close();
      }
    },
  );
}
