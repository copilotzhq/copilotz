import assert from "node:assert/strict";
import { test } from "node:test";
import { readOwnerOriginalExecutionContract } from "./execution-contract.ts";
import { fixture } from "./execution.fixture.test.ts";

test("a newly converted deployment cannot upgrade an old unconverted attempt's empty effect history", async () => {
  let allowed = false;
  const f = await fixture({ allowRecovery: () => allowed });
  try {
    await f.port().claim(f.hint(), {});
    const original = (await f.db.query<{ result: Record<string, unknown> }>(
      "SELECT result FROM owner_receipts WHERE key=$1",
      [f.claimCommand().key],
    )).rows[0].result;
    assert.equal(Object.hasOwn(original, "contract"), false);
    allowed = true;
    // An original fresh-claim duplicate cannot capture today's new eligibility.
    assert.equal(
      (await f.boundary.execute(f.caller(), f.claimCommand())).status,
      "duplicate",
    );
    assert.deepEqual(
      (await f.db.query("SELECT result FROM owner_receipts WHERE key=$1", [
        f.claimCommand().key,
      ])).rows[0].result,
      original,
    );
    await f.seedRetiredAttemptForBarrier();
    await f.replace({ workerId: "new-converted-worker" });
    await f.port().claim(f.hint(), {});
    assert.equal(
      (await f.port().project(f.reference(), {})).recovery?.status,
      "blocked",
    );
    await assert.rejects(f.effects().begin("unsafe-new-send"), {
      code: "effect_indeterminate",
    });
    await assert.rejects(
      f.port().complete(
        f.reference(),
        { status: "completed", output: null },
        {},
      ),
      { code: "effect_indeterminate" },
    );
    const delivery = await f.store.getDelivery(f.reference().deliveryId);
    assert.equal(delivery?.attempts, 2);
    assert.equal(delivery?.maxAttempts, 4); // This existing fixture explicitly configures four.
    const retried = (await f.db.query<{ result: Record<string, unknown> }>(
      "SELECT result FROM owner_receipts WHERE key=$1",
      [f.claimCommand().key],
    )).rows[0].result;
    assert.equal(Object.hasOwn(retried, "contract"), false);
  } finally {
    await f.close();
  }
});

test("original eligible claim records exact historical provenance without changing logical references", async () => {
  const f = await fixture({ allowRecovery: () => true });
  try {
    const outcome = await f.port().claim(f.hint(), {});
    assert.deepEqual(outcome.result, f.reference());
    const row = (await f.db.query<{ result: Record<string, unknown> }>(
      "SELECT result FROM owner_receipts WHERE key=$1",
      [f.claimCommand().key],
    )).rows[0];
    const contract = row.result.contract as Record<string, unknown>;
    assert.deepEqual(contract, {
      protocol: "copilotz.owner-effects.v1",
      attempt: 1,
      ownerEpoch: 1,
      ownerId: "owner",
      namespace: "space",
      actionId: "fixture.work",
      actionRunId: "run",
      sourceEventId: f.source.event.id,
      deliveryId: f.reference().deliveryId,
      workerId: "worker",
      assignmentId: "assignment",
      sessionId: "session",
      dispatchAttemptId: "attempt-1",
    });
    const scope = {
      ownerId: "owner",
      schema: "public",
      epoch: 1,
      namespace: "space",
      actionId: "fixture.work",
      actionRunId: "run",
      sourceEventId: f.source.event.id,
      deliveryId: f.reference().deliveryId,
    };
    assert.deepEqual(
      await readOwnerOriginalExecutionContract(f.db, scope),
      contract,
    );
    for (
      const invalid of [
        undefined,
        { ...contract, protocol: "unknown" },
        { ...contract, ownerEpoch: 2 },
        { ...contract, namespace: "other" },
        { ...contract, workerId: "other" },
        { ...contract, sessionId: "other" },
      ]
    ) {
      const changed = { ...row.result };
      if (invalid === undefined) delete changed.contract;
      else changed.contract = invalid;
      await f.db.query(
        "UPDATE owner_receipts SET result=$1::jsonb WHERE key=$2",
        [JSON.stringify(changed), f.claimCommand().key],
      );
      assert.equal(
        await readOwnerOriginalExecutionContract(f.db, scope),
        undefined,
      );
    }
    await f.db.query(
      "UPDATE owner_receipts SET result=$1::jsonb WHERE key=$2",
      [JSON.stringify(row.result), f.claimCommand().key],
    );
    await f.db.query(
      `INSERT INTO owner_receipts(owner,principal_kind,principal_id,domain,key,kind,intent,result)
      SELECT owner,principal_kind,principal_id,domain,'duplicate-contract-candidate',kind,intent,result FROM owner_receipts WHERE key=$1`,
      [f.claimCommand().key],
    );
    assert.equal(
      await readOwnerOriginalExecutionContract(f.db, scope),
      undefined,
    );
    await f.db.query(
      "DELETE FROM owner_receipts WHERE key='duplicate-contract-candidate'",
    );
    assert.deepEqual(
      await readOwnerOriginalExecutionContract(f.db, scope),
      contract,
    );
    await f.seedRetiredAttemptForBarrier();
    await f.replace();
    await f.port().claim(f.hint(), {});
    assert.equal(
      (await f.port().project(f.reference(), {})).recovery?.status,
      "eligible",
    );
    const retry = (await f.db.query<{ result: Record<string, unknown> }>(
      "SELECT result FROM owner_receipts WHERE key=$1",
      [f.claimCommand().key],
    )).rows[0].result;
    assert.equal(Object.hasOwn(retry, "contract"), false);
    assert.equal(
      (await f.store.getDelivery(f.reference().deliveryId))?.attempts,
      2,
    );
  } finally {
    await f.close();
  }
});

test("fresh claim rollback leaves no historical contract or consumed attempt", async () => {
  const f = await fixture({ allowRecovery: () => true });
  try {
    f.state.rejectOuter = true;
    await assert.rejects(f.port().claim(f.hint(), {}));
    assert.equal(
      (await f.db.query("SELECT result FROM owner_receipts WHERE key=$1", [
        f.claimCommand().key,
      ])).rows.length,
      0,
    );
    assert.equal(
      (await f.store.getDelivery(f.reference().deliveryId))?.attempts,
      0,
    );
    assert.equal(
      (await f.db.query("SELECT * FROM open_actions")).rows.length,
      0,
    );
  } finally {
    await f.close();
  }
});
