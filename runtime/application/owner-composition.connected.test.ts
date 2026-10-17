import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerApplicationFixture } from "../../contracts/package/fixtures/owner-application.ts";
import { connect } from "../../contracts/package/fixtures/owner-whole-plugin.ts";

async function eventually(check: () => Promise<boolean>) {
  const until = Date.now() + 15_000;
  while (!await check()) {
    if (Date.now() > until) {
      throw new Error("public owner application timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
const source = process.env.COPILOTZ_OXIAN_SOURCE_ROOT;
for (const mode of ["in-process", "websocket"] as const) {
  test(
    `public same-factory ${mode}: storage and owner placements share whole-plugin durable semantics`,
    { skip: !source, timeout: 60_000 },
    async () => {
      const fixture = await ownerApplicationFixture(
        source!,
        mode,
        mode === "in-process",
      );
      let remote: Awaited<ReturnType<typeof connect>> | undefined;
      try {
        assert.equal(
          await fixture.app.actions.write("embedded", {
            idempotencyKey: "first",
          }),
          "whole:embedded",
        );
        await eventually(async () =>
          (await fixture.query(
            "SELECT id FROM nodes WHERE id='reply:embedded'",
          )).rows.length === 1
        );
        assert.equal(
          await fixture.app.actions.write("embedded", {
            idempotencyKey: "first",
          }),
          "whole:embedded",
        );
        await assert.rejects(
          fixture.app.actions.write("changed", { idempotencyKey: "first" }),
        );
        await assert.rejects(
          fixture.app.actions.child("denied", { idempotencyKey: "denied" }),
        );
        remote = await connect(fixture.ownerOptions);
        await remote.ready;
        assert.equal(
          await remote.actions.write("embedded", { idempotencyKey: "first" }),
          "whole:embedded",
          "same public logical key replays across worker identities",
        );
        fixture.setExecutionWorker("remote");
        assert.equal(
          await remote.actions.write("remote", { idempotencyKey: "second" }),
          "whole:remote",
        );
        await eventually(async () =>
          (await fixture.query("SELECT id FROM nodes WHERE id='reply:remote'"))
            .rows.length === 1
        );
        assert.equal(
          await remote.actions.write("remote", { idempotencyKey: "second" }),
          "whole:remote",
        );
        await assert.rejects(
          remote.actions.write("changed", { idempotencyKey: "second" }),
        );
        const remoteAssignments = await fixture.query(
          "SELECT binding FROM owner_assignments WHERE binding->>'workerId'='remote'",
        );
        assert.ok(
          remoteAssignments.rows.length >= 3,
          "Action, Processor and child Action executed on connected worker",
        );
        assert.equal(
          (await fixture.query("SELECT id FROM nodes WHERE id='note:changed'"))
            .rows.length,
          0,
        );
        await eventually(async () =>
          (await fixture.query(
            "SELECT status FROM event_deliveries WHERE status NOT IN ('succeeded','dead_letter','cancelled')",
          )).rows.length === 0
        );
        assert.deepEqual(fixture.errors, []);
        fixture.loseNextAdmissionReply();
        await assert.rejects(
          remote.actions.write("uncertain", { idempotencyKey: "uncertain" }),
        );
        await Promise.race([
          fixture.app.closed,
          new Promise<never>((_resolve, reject) => {
            const timer = setTimeout(
              () =>
                reject(
                  new Error("public closed did not follow owner retirement"),
                ),
              5000,
            );
            void fixture.app.closed.finally(() => clearTimeout(timer));
          }),
        ]);
        // Closed means transport cleanup finished; the injected SQL session is still caller-owned.
        assert.equal(
          (await fixture.query(
            "SELECT id FROM nodes WHERE id='note:uncertain'",
          )).rows.length,
          0,
        );
        assert.ok(
          (await fixture.query(
            "SELECT key FROM owner_receipts WHERE kind='action.admit'",
          )).rows.length >= 3,
        );
        await assert.rejects(
          fixture.app.actions.write("after-close", {
            idempotencyKey: "after-close",
          }),
        );
      } finally {
        await remote?.close();
        await fixture.close();
      }
    },
  );
}
