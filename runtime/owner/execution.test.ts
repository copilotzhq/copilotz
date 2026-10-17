import assert from "node:assert/strict";
import { test } from "node:test";
import { defineAction } from "../actions/define.ts";
import { createActionLifecycleLoader } from "../actions/persistence.ts";
import type { AnyActionDefinition } from "../actions/types.ts";
import { ownerRenewalKey } from "../execution/owner-port.ts";
import { createOperationCatalog } from "../streams/catalog.ts";
import { createOwnerOperationSettlement } from "./settlement.ts";
import { createOwnerTransactionPlanner } from "./transaction.ts";
import type { OwnerCommand, OwnerInputCommand, OwnerJson } from "./boundary.ts";
import {
  at,
  deferred,
  fixture,
  snapshot,
  start,
  within,
} from "./execution.fixture.test.ts";

test("registered Action claims real delivery, uses owner Collection plan, completes lifecycle and safe replay", async () => {
  const f = await fixture();
  try {
    const worker = f.worker();
    const result = await worker.execute(f.hint());
    assert.equal(result.status, "executed");
    if (result.status === "executed") {
      assert.deepEqual(result.completion, {
        status: "completed",
        output: { id: "note", message: "hello world!" },
      });
    }
    await within(f.observed.promise);
    assert.deepEqual(f.state.observations, [1]);
    assert.equal(f.state.executions, 1);
    assert.equal(f.state.persistenceOpens, 0);
    assert.equal(
      (await f.store.getDelivery(f.reference().deliveryId))?.status,
      "succeeded",
    );
    assert.equal(
      (await f.db.query("SELECT * FROM open_actions")).rows.length,
      0,
    );
    const terminal = await createActionLifecycleLoader({ store: f.store })(
      "space",
      "run:action:terminal",
    );
    assert.equal(terminal?.status, "completed");
    const receipt = await f.port().readCompletion(f.reference(), {});
    assert.deepEqual(receipt, { ...f.reference(), status: "completed" });
    assert.equal(JSON.stringify(receipt).includes("world"), false);
    const projections = f.state.projections;
    await f.set("ctx_granted", false);
    assert.equal((await worker.execute(f.hint())).status, "replayed");
    assert.equal((await f.worker().execute(f.hint())).status, "replayed");
    assert.equal(f.state.projections, projections);
    assert.equal(f.state.executions, 1);
    await assert.rejects(f.port().project(f.reference(), {}), {
      code: "ActionOwnershipLost",
    });
    await assert.rejects(f.boundary.execute(f.caller(), f.claimCommand()), {
      code: "ActionOwnershipLost",
    });
  } finally {
    await f.close();
  }
});

test("claim input and terminal caller output remain behind outer commit", async () => {
  for (const kind of ["execution.claim", "execution.complete"]) {
    const f = await fixture();
    try {
      f.state.gateKind = kind;
      let exposed = false;
      const pending = f.worker().execute(f.hint()).then((value) => {
        exposed = true;
        return value;
      });
      await within(f.gate.reached.promise);
      assert.equal(exposed, false);
      if (kind === "execution.claim") {
        assert.equal(f.state.executions, 0);
        assert.deepEqual(f.state.publications, []);
      } else {
        assert.equal(f.state.executions, 1);
        assert.equal(
          f.state.publications.includes("fixture.work.completed"),
          false,
        );
      }
      f.gate.release.resolve();
      assert.equal((await within(pending)).status, "executed");
    } finally {
      await f.close();
    }
  }
});

test("claim and completion rollback lifecycle, delivery, sequence and receipt together", async () => {
  for (const kind of ["claim", "complete"]) {
    const f = await fixture();
    try {
      if (kind === "complete") await f.port().claim(f.hint(), {});
      const before = await snapshot(f.db);
      const count = f.state.publications.length;
      f.state.rollback = true;
      await assert.rejects(
        kind === "claim"
          ? f.freshPort().claim(f.hint(), {})
          : f.port().complete(f.reference(), {
            status: "completed",
            output: { id: "n", message: "x" },
          }, {}),
        /injected command rollback/,
      );
      assert.notDeepEqual(f.state.rollbackSnapshot, before);
      assert.deepEqual(await snapshot(f.db), before);
      assert.equal(f.state.publications.length, count);
      assert.equal(
        (await (kind === "claim"
          ? f.freshPort().claim(f.hint(), {})
          : f.port().complete(f.reference(), {
            status: "completed",
            output: { id: "n", message: "x" },
          }, {}))).status,
        "committed",
      );
    } finally {
      await f.close();
    }
  }
});

test("revoked input projection and general mutation do not revoke narrow live settlement authority", async () => {
  const f = await fixture();
  try {
    await f.port().claim(f.hint(), {});
    await f.set("input_granted", false);
    await assert.rejects(
      f.port().project(f.reference(), {}),
      /input authorization revoked/,
    );
    await f.set("ctx_granted", false);
    await assert.rejects(f.boundary.execute(f.caller(), f.claimCommand()), {
      code: "ActionOwnershipLost",
    });
    await assert.rejects(
      f.port().execute({
        kind: "collections",
        domain: "logical",
        key: "root/work/write",
        intent: { operations: [] },
      }),
      { code: "ActionOwnershipLost" },
    );
    const result = await f.port().complete(f.reference(), {
      status: "failed",
      code: "action_failed",
    }, {});
    assert.equal(result.result.status, "failed");
    assert.equal(
      (await f.store.getDelivery(f.reference().deliveryId))?.status,
      "dead_letter",
    );
  } finally {
    await f.close();
  }
});

test("lost completion reply recovers references after settlement without rerunning business code", async () => {
  const f = await fixture();
  try {
    f.state.lostCompletion = true;
    await assert.rejects(
      f.worker().execute(f.hint()),
      /lost committed completion reply/,
    );
    await f.set("ctx_granted", false);
    const recovered = await f.worker().execute(f.hint());
    assert.equal(recovered.status, "replayed");
    assert.equal(f.state.executions, 1);
    assert.deepEqual(await f.port().readCompletion(f.reference(), {}), {
      ...f.reference(),
      status: "completed",
    });
    assert.equal(
      (await f.db.query(
        "SELECT id FROM events WHERE deduplication_id='run:action:terminal'",
      )).rows.length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("expiry, replacement assignment and stale epoch cannot hydrate or settle", async () => {
  const f = await fixture();
  try {
    const oldCaller = f.caller();
    const oldPort = f.port(oldCaller);
    const oldRef = f.reference();
    await oldPort.claim(f.hint(), {});
    f.state.time = at(1000);
    await assert.rejects(oldPort.project(oldRef, {}), {
      code: "ActionOwnershipLost",
    });
    await assert.rejects(
      oldPort.complete(oldRef, { status: "failed", code: "action_failed" }, {}),
      { code: "ActionOwnershipLost" },
    );
    await f.replace();
    f.state.time = at(1001);
    await f.port().claim(f.hint(), {});
    assert.equal((await f.store.getDelivery(oldRef.deliveryId))?.attempts, 2);
    assert.equal((await f.port().project(f.reference(), {})).input, "world");
    await assert.rejects(
      oldPort.complete(oldRef, { status: "failed", code: "action_failed" }, {}),
      { code: "ActionOwnershipLost" },
    );
    await assert.rejects(
      f.boundary.executeInput(
        { ...f.caller(), ownerEpoch: 0 },
        f.completeCommand({ status: "cancelled", code: "action_cancelled" }),
      ),
      { code: "ActionOwnershipLost" },
    );
    await f.port().complete(f.reference(), {
      status: "cancelled",
      code: "action_cancelled",
    }, {});
    const prior = await snapshot(f.db);
    await assert.rejects(oldPort.project(oldRef, {}), {
      code: "ActionOwnershipLost",
    });
    assert.deepEqual(await snapshot(f.db), prior);
  } finally {
    await f.close();
  }
});

test("current scope cancellation takes precedence over success and failure, with one cancellation terminal", async () => {
  const f = await fixture();
  try {
    await f.port().claim(f.hint(), {});
    await f.db.query(
      "UPDATE copilotz_operations SET cancellation_requested_at=$1 WHERE operation_id=$2",
      [start, f.source.event.id],
    );
    const before = await snapshot(f.db);
    for (
      const completion of [{
        status: "completed",
        output: { id: "n", message: "x" },
      }, { status: "failed", code: "action_failed" }] as const
    ) {
      await assert.rejects(f.port().complete(f.reference(), completion, {}), {
        code: "ActionOwnershipLost",
      });
    }
    await assert.rejects(f.port().project(f.reference(), {}), {
      code: "ActionOwnershipLost",
    });
    assert.deepEqual(await snapshot(f.db), before);
    assert.equal(
      (await f.port().complete(f.reference(), {
        status: "cancelled",
        code: "action_cancelled",
      }, {})).result.status,
      "cancelled",
    );
    assert.equal(
      (await f.store.getDelivery(f.reference().deliveryId))?.status,
      "cancelled",
    );
    assert.equal(
      (await f.db.query(
        "SELECT id FROM events WHERE deduplication_id='run:action:terminal'",
      )).rows.length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("competing terminal commands share one logical identity; settled replay is read-only recovery", async () => {
  const f = await fixture();
  try {
    await f.port().claim(f.hint(), {});
    const outcomes = await Promise.allSettled([
      f.port().complete(f.reference(), {
        status: "completed",
        output: { id: "n", message: "x" },
      }, {}),
      f.port().complete(f.reference(), {
        status: "failed",
        code: "action_failed",
      }, {}),
      f.port().complete(f.reference(), {
        status: "cancelled",
        code: "action_cancelled",
      }, {}),
    ]);
    assert.deepEqual(outcomes.map((item) => item.status), [
      "fulfilled",
      "rejected",
      "rejected",
    ]);
    assert.equal(
      (await f.db.query(
        "SELECT id FROM events WHERE deduplication_id='run:action:terminal'",
      )).rows.length,
      1,
    );
    assert.equal(
      (await f.db.query(
        "SELECT key FROM owner_receipts WHERE kind='execution.complete'",
      )).rows.length,
      1,
    );
    await assert.rejects(
      f.port().complete(f.reference(), {
        status: "completed",
        output: { id: "n", message: "x" },
      }, {}),
      { code: "ActionOwnershipLost" },
    );
    assert.equal(
      (await f.port().readCompletion(f.reference(), {}))?.status,
      "completed",
    );
  } finally {
    await f.close();
  }
});

test("command keys, namespace and invocation are reauthorized on duplicate claims", async () => {
  const f = await fixture();
  try {
    await f.port().claim(f.hint(), {});
    assert.equal(
      (await f.boundary.execute(f.caller(), f.claimCommand())).status,
      "duplicate",
    );
    for (
      const command of [
        { ...f.claimCommand(), key: "forged" },
        {
          ...f.claimCommand(),
          intent: { assignmentId: "other", sessionId: "session" },
        },
        {
          ...f.completeCommand({ status: "failed", code: "action_failed" }),
          key: "status:failed",
        },
        {
          ...f.completeCommand({ status: "failed", code: "action_failed" }),
          input: {
            namespace: "other",
            executionId: "run",
            completion: { status: "failed", code: "action_failed" },
          },
        },
      ]
    ) {
      await assert.rejects(
        command.kind === "execution.complete"
          ? f.boundary.executeInput(f.caller(), command as OwnerInputCommand)
          : f.boundary.execute(f.caller(), command as OwnerCommand),
        { code: "ActionOwnershipLost" },
      );
    }
    await f.set("ctx_granted", false);
    await assert.rejects(f.boundary.execute(f.caller(), f.claimCommand()), {
      code: "ActionOwnershipLost",
    });
  } finally {
    await f.close();
  }
});

test("different-worker settled recovery cannot grant hydration or business reexecution", async () => {
  const f = await fixture();
  try {
    await f.worker().execute(f.hint());
    const originalRef = f.reference();
    await f.replace({ workerId: "replacement-worker" });
    assert.equal(await f.port().readCompletion(originalRef, {}), undefined);
    await assert.rejects(f.worker().execute(f.hint()), {
      code: "ActionOwnershipLost",
    });
    assert.equal(f.state.executions, 1);
    assert.equal(
      (await f.db.query(
        "SELECT id FROM events WHERE deduplication_id='run:action:terminal'",
      )).rows.length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("inline input, protected, content and deferred Actions refuse before claim or hydration", async () => {
  const definitions: { action?: AnyActionDefinition; inline?: boolean }[] = [
    { inline: true },
    {
      action: defineAction({
        id: "secret",
        inputSchema: { type: "string", "x-copilotz-secret": true } as never,
        execute: () => null,
      }),
    },
    {
      action: {
        id: "content",
        content: { input: ["body"] },
        execute: () => null,
      },
    },
    {
      action: {
        id: "deferred",
        execute: () => null,
        resolve: () => null,
      } as AnyActionDefinition,
    },
  ];
  for (const input of definitions) {
    const f = await fixture(input);
    try {
      const before = await snapshot(f.db);
      await assert.rejects(f.port().claim(f.hint(), {}));
      assert.deepEqual(await snapshot(f.db), before);
      assert.equal(f.state.executions, 0);
      assert.equal(f.state.projections, 0);
    } finally {
      await f.close();
    }
  }
});

test("forged provider details and inconsistent failure codes cannot enter terminal lifecycle", async () => {
  const f = await fixture();
  try {
    await f.port().claim(f.hint(), {});
    const before = await snapshot(f.db);
    for (
      const completion of [
        { status: "failed", code: "private_provider_token" },
        { status: "failed", code: "action_cancelled" },
        { status: "cancelled", code: "action_failed" },
      ] as const
    ) {
      await assert.rejects(
        f.port().complete(f.reference(), completion, {}),
        /Invalid safe execution failure code/,
      );
    }
    assert.deepEqual(await snapshot(f.db), before);
    assert.equal(
      (await f.port().complete(f.reference(), {
        status: "failed",
        code: "action_capability_unsupported",
      }, {})).result.status,
      "failed",
    );
  } finally {
    await f.close();
  }
});

test("captured invoked input survives source changes and current replacement reads only that capture", async () => {
  const f = await fixture();
  try {
    await f.port().claim(f.hint(), {});
    await f.db.query(
      "UPDATE event_bodies SET body=$1::jsonb WHERE event_body_id='source-input'",
      [JSON.stringify("changed")],
    );
    assert.equal((await f.port().project(f.reference(), {})).input, "world");
    f.state.time = at(1001);
    await f.replace();
    await f.port().claim(f.hint(), {});
    assert.equal((await f.port().project(f.reference(), {})).input, "world");
    assert.equal(
      (await f.db.query(
        "SELECT id FROM events WHERE deduplication_id='run:action:invoked'",
      )).rows.length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("lost parent assignment or settlement grant blocks restricted completion after ctx revocation", async () => {
  for (const column of ["settlement_granted", "live"] as const) {
    const f = await fixture();
    try {
      await f.port().claim(f.hint(), {});
      await f.set("ctx_granted", false);
      await f.set(column, false);
      const before = await snapshot(f.db);
      await assert.rejects(
        f.port().complete(f.reference(), {
          status: "cancelled",
          code: "action_cancelled",
        }, {}),
        { code: "ActionOwnershipLost" },
      );
      assert.deepEqual(await snapshot(f.db), before);
    } finally {
      await f.close();
    }
  }
});

test("unknown outer claim or completion rolls back all effects and stops the owner without output", async () => {
  for (const terminal of [false, true]) {
    const f = await fixture();
    try {
      if (terminal) await f.port().claim(f.hint(), {});
      const before = await snapshot(f.db);
      const publications = f.state.publications.length;
      f.state.rejectOuter = true;
      // Direct command avoids the separate recovery-read transaction consuming
      // this deliberately injected outer-command failure.
      await assert.rejects(
        terminal
          ? f.boundary.executeInput(
            f.caller(),
            f.completeCommand({ status: "failed", code: "action_failed" }),
          )
          : f.boundary.execute(f.caller(), f.claimCommand()),
        { code: "owner_commit_unknown" },
      );
      assert.deepEqual(await snapshot(f.db), before);
      assert.equal(f.state.publications.length, publications);
      assert.equal(f.boundary.state, "stopped");
      assert.equal(f.state.executions, 0);
    } finally {
      await f.close();
    }
  }
});

function renewalCommand(
  f: Awaited<ReturnType<typeof fixture>>,
  sequence = 1,
): OwnerCommand {
  const hint = f.hint();
  return {
    kind: "execution.renew",
    domain: "occurrence",
    key: ownerRenewalKey("owner", hint.assignmentId, hint.sessionId, sequence),
    intent: { reference: f.reference(), sequence },
  };
}
async function waitForRenewals(
  f: Awaited<ReturnType<typeof fixture>>,
  count: number,
) {
  await within((async () => {
    while (
      (await f.db.query(
        "SELECT 1 FROM owner_receipts WHERE kind='execution.renew'",
      )).rows.length < count
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  })());
}

test("actual registered long Action renews the current lease and settles after the original expiry", async () => {
  const entered = deferred();
  const release = deferred();
  const f = await fixture({
    async afterAction() {
      entered.resolve();
      await release.promise;
    },
  });
  try {
    const pending = f.worker().execute(f.hint());
    await within(entered.promise);
    f.state.time = at(700);
    await waitForRenewals(f, 1);
    assert.equal(
      (await f.store.getDelivery(f.reference().deliveryId))?.leaseExpiresAt,
      at(1700),
    );
    f.state.time = at(1400);
    await waitForRenewals(f, 2);
    f.state.time = at(2100);
    release.resolve();
    assert.equal((await within(pending)).receipt.status, "completed");
    assert.equal(f.state.executions, 1);
    assert.equal(
      (await f.store.getDelivery(f.reference().deliveryId))?.status,
      "succeeded",
    );
    assert.equal((await f.db.query("SELECT id FROM nodes")).rows.length, 1);
    const count = (await f.db.query(
      "SELECT 1 FROM owner_receipts WHERE kind='execution.renew'",
    )).rows.length;
    await new Promise<void>((resolve) => setTimeout(resolve, 370));
    assert.equal(
      (await f.db.query(
        "SELECT 1 FROM owner_receipts WHERE kind='execution.renew'",
      )).rows.length,
      count,
    );
  } finally {
    release.resolve();
    await f.close();
  }
});

test("owner renewal uses captured commandTime, occurrence identity, and current authorization before duplicate lookup", async () => {
  const f = await fixture();
  try {
    const claim = await f.port().claim(f.hint(), {});
    assert.deepEqual(Object.keys(claim.result).sort(), [
      "deliveryId",
      "dispatchAttemptId",
      "executionId",
    ]);
    assert.deepEqual((await f.port().project(f.reference(), {})).lease, {
      remainingMs: 1000,
      renewAfterMs: 333,
    });
    const command = renewalCommand(f);
    f.state.time = at(700);
    const result = await f.boundary.execute(f.caller(), command);
    assert.deepEqual(result.result, {
      ...f.reference(),
      lease: { remainingMs: 1000, renewAfterMs: 333 },
    });
    assert.equal(
      (await f.store.getDelivery(f.reference().deliveryId))?.leaseExpiresAt,
      at(1700),
    );
    f.state.time = at(900);
    assert.equal(
      (await f.boundary.execute(f.caller(), command)).status,
      "duplicate",
    );
    assert.equal(
      (await f.store.getDelivery(f.reference().deliveryId))?.leaseExpiresAt,
      at(1700),
    );
    await f.set("ctx_granted", false);
    const before = await snapshot(f.db);
    await assert.rejects(f.boundary.execute(f.caller(), command), {
      code: "ActionOwnershipLost",
    });
    assert.deepEqual(await snapshot(f.db), before);
    assert.equal(
      (await f.port().complete(f.reference(), {
        status: "failed",
        code: "action_failed",
      }, {})).result.status,
      "failed",
    );
  } finally {
    await f.close();
  }
});

test("renewal refuses forged identity, stale assignment, expired lease, cancellation and terminal execution", async () => {
  const f = await fixture();
  try {
    await f.port().claim(f.hint(), {});
    await f.port().project(f.reference(), {});
    const caller = f.caller();
    const command = renewalCommand(f);
    const before = await snapshot(f.db);
    for (
      const invalid of [
        { ...command, domain: "incarnation" as const },
        { ...command, key: "forged" },
        {
          ...command,
          intent: {
            reference: { ...f.reference(), dispatchAttemptId: "old" },
            sequence: 1,
          },
        },
        { ...command, intent: { reference: f.reference(), sequence: 0 } },
      ]
    ) await assert.rejects(f.boundary.execute(caller, invalid));
    assert.deepEqual(await snapshot(f.db), before);
    f.state.time = at(1000);
    await assert.rejects(f.boundary.execute(caller, command), {
      code: "ActionOwnershipLost",
    });
    await f.replace();
    await f.port().claim(f.hint(), {});
    await assert.rejects(f.boundary.execute(caller, command), {
      code: "ActionOwnershipLost",
    });
    await f.db.query(
      "UPDATE copilotz_operations SET cancellation_requested_at=$1 WHERE operation_id=$2",
      [at(1000), f.source.event.id],
    );
    await assert.rejects(f.boundary.execute(f.caller(), renewalCommand(f)), {
      code: "ActionOwnershipLost",
    });
    await f.port().complete(f.reference(), {
      status: "cancelled",
      code: "action_cancelled",
    }, {});
    await assert.rejects(f.boundary.execute(f.caller(), renewalCommand(f)), {
      code: "ActionOwnershipLost",
    });
    assert.equal(
      (await f.db.query(
        "SELECT 1 FROM owner_receipts WHERE kind='execution.renew'",
      )).rows.length,
      0,
    );
  } finally {
    await f.close();
  }
});

test("renewal receipt and lease change roll back together and unknown outer rollback stops the owner", async () => {
  for (const unknown of [false, true]) {
    const f = await fixture();
    try {
      await f.port().claim(f.hint(), {});
      f.state.time = at(700);
      const before = await snapshot(f.db);
      if (unknown) f.state.rejectOuter = true;
      else f.state.rollback = true;
      await assert.rejects(
        f.boundary.execute(f.caller(), renewalCommand(f)),
        unknown
          ? { code: "owner_commit_unknown" }
          : /injected command rollback/,
      );
      assert.deepEqual(await snapshot(f.db), before);
      assert.equal(f.boundary.state, unknown ? "stopped" : "acquired");
    } finally {
      await f.close();
    }
  }
});

test("current ctx revocation during a long Action aborts capabilities but permits safe restricted settlement", async () => {
  const entered = deferred();
  let failedMutation = false;
  const f = await fixture({
    async afterAction(ctx) {
      entered.resolve();
      await new Promise<void>((resolve) =>
        ctx.signal.addEventListener("abort", () => resolve(), { once: true })
      );
      await assert.rejects(async () =>
        await ctx.transaction(() => null, { operationKey: "after-revoke" })
      );
      failedMutation = true;
    },
  });
  try {
    const pending = f.worker().execute(f.hint());
    await within(entered.promise);
    await f.set("ctx_granted", false);
    const result = await within(pending);
    assert.equal(result.receipt.status, "failed");
    assert.equal(failedMutation, true);
    assert.equal(f.state.executions, 1);
    assert.equal(
      (await f.db.query("SELECT id FROM nodes")).rows.length,
      1,
      "already committed business effects are not rolled back",
    );
    assert.equal(
      (await f.db.query(
        "SELECT 1 FROM owner_receipts WHERE kind='execution.renew'",
      )).rows.length,
      0,
    );
  } finally {
    await f.close();
  }
});

test("renewal acknowledgement remains behind outer commit and carries no Action data", async () => {
  const f = await fixture();
  try {
    await f.port().claim(f.hint(), {});
    f.state.time = at(700);
    f.state.gateKind = "execution.renew";
    let exposed = false;
    const pending = f.boundary.execute(f.caller(), renewalCommand(f)).then(
      (value) => {
        exposed = true;
        return value;
      },
    );
    await within(f.gate.reached.promise);
    assert.equal(exposed, false);
    f.gate.release.resolve();
    const result = await within(pending);
    assert.deepEqual(result.result, {
      ...f.reference(),
      lease: { remainingMs: 1000, renewAfterMs: 333 },
    });
    assert.equal(JSON.stringify(result).includes("world"), false);
  } finally {
    await f.close();
  }
});

test("lost committed renewal reply aborts capability scope and never reexecutes the claimed Action", async () => {
  const entered = deferred();
  const f = await fixture({
    async afterAction(ctx) {
      entered.resolve();
      await new Promise<void>((resolve) =>
        ctx.signal.addEventListener("abort", () => resolve(), { once: true })
      );
    },
  });
  try {
    const worker = f.worker();
    const pending = worker.execute(f.hint());
    await within(entered.promise);
    f.state.time = at(700);
    f.state.lostRenewal = true;
    await assert.rejects(within(pending), /lost committed renewal reply/);
    assert.equal(
      (await f.store.getDelivery(f.reference().deliveryId))?.leaseExpiresAt,
      at(1700),
    );
    assert.equal(
      (await f.db.query(
        "SELECT 1 FROM owner_receipts WHERE kind='execution.renew'",
      )).rows.length,
      1,
    );
    assert.equal(
      (await f.db.query(
        "SELECT 1 FROM events WHERE deduplication_id='run:action:terminal'",
      )).rows.length,
      0,
    );
    await assert.rejects(
      worker.execute(f.hint()),
      /lost committed renewal reply/,
    );
    await assert.rejects(f.worker().execute(f.hint()), {
      code: "registered_worker_replay_refused",
    });
    assert.equal(f.state.executions, 1);
    assert.equal((await f.db.query("SELECT id FROM nodes")).rows.length, 1);
  } finally {
    await f.close();
  }
});

test("owner Action lifecycle preserves the trusted source correlation and causation", async () => {
  const f = await fixture();
  try {
    await f.worker().execute(f.hint());
    for (const suffix of ["invoked", "terminal"]) {
      const event = await f.store.getEventByDeduplicationId(
        "space",
        `run:action:${suffix}`,
      );
      assert.equal(
        event?.correlationId,
        f.source.event.correlationId,
        `${suffix} correlation`,
      );
      assert.equal(
        event?.causationId,
        f.source.event.id,
        `${suffix} causation`,
      );
    }
  } finally {
    await f.close();
  }
});

test("owner Action accepts the exact safe effect_indeterminate failure code", async () => {
  const f = await fixture();
  try {
    await f.port().claim(f.hint(), {});
    await f.port().complete(f.reference(), {
      status: "failed",
      code: "effect_indeterminate",
    }, {});
    const data = await createActionLifecycleLoader({
      store: f.store,
      actions: f.registry.actions,
    })("space", "run:action:terminal");
    assert.equal(data?.status, "failed");
    assert.equal(
      data && "error" in data ? data.error.code : undefined,
      "effect_indeterminate",
    );
    assert.equal(
      (await f.store.getDelivery(f.reference().deliveryId))?.status,
      "dead_letter",
    );
  } finally {
    await f.close();
  }
});

test("owner Action claim and completion schedule settlement atomically, but renewal and duplicate commands do not", async () => {
  const woke: string[] = [];
  const f = await fixture({
    scheduleSettlement: (ctx, target) => settlement.schedule(ctx, target),
  });
  const settlement = createOwnerOperationSettlement({
    ownerId: "owner",
    schema: "public",
    session: f.db,
    catalog: createOperationCatalog(f.db),
    authorizeControl: () => true,
    selectDrains: () => [],
    authorizeDrain: () => false,
    drain: () => Promise.resolve(false),
    wake: (target) => {
      woke.push(target.operationId);
    },
  });
  try {
    f.state.gateKind = "execution.claim";
    const port = f.port();
    const claim = port.claim(f.hint(), {});
    await within(f.gate.reached.promise);
    assert.equal(woke.length, 0);
    f.gate.release.resolve();
    await claim;
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(woke, [f.source.event.id]);
    assert.equal(
      (await f.db.query("SELECT * FROM owner_alarms")).rows.length,
      1,
    );
    assert.equal(
      (await f.boundary.execute(f.caller(), f.claimCommand())).status,
      "duplicate",
    );
    assert.equal(woke.length, 1);
    await port.project(f.reference(), {});
    await port.renew(f.reference(), {});
    assert.equal(woke.length, 1);
    await port.complete(f.reference(), {
      status: "failed",
      code: "action_failed",
    }, {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(woke, [f.source.event.id, f.source.event.id]);
    assert.equal(
      (await f.db.query("SELECT * FROM owner_alarms")).rows.length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("settlement scheduling failure rolls back claim, alarm, receipt and staged wake together", async () => {
  let reject = true;
  let wakes = 0;
  const f = await fixture({
    scheduleSettlement: async (ctx, target) => {
      await settlement.schedule(ctx, target);
      if (reject) throw new Error("schedule rollback");
    },
  });
  const settlement = createOwnerOperationSettlement({
    ownerId: "owner",
    schema: "public",
    session: f.db,
    catalog: createOperationCatalog(f.db),
    authorizeControl: () => true,
    selectDrains: () => [],
    authorizeDrain: () => false,
    drain: () => Promise.resolve(false),
    wake: () => {
      wakes++;
    },
  });
  try {
    await assert.rejects(
      f.boundary.execute(f.caller(), f.claimCommand()),
      /schedule rollback/,
    );
    assert.equal(
      (await f.db.query("SELECT * FROM owner_alarms")).rows.length,
      0,
    );
    assert.equal(
      (await f.db.query(
        "SELECT * FROM owner_receipts WHERE kind='execution.claim'",
      )).rows.length,
      0,
    );
    assert.equal(
      (await f.store.getDelivery(f.reference().deliveryId))?.status,
      "pending",
    );
    assert.equal(
      await f.store.getEventByDeduplicationId("space", "run:action:invoked"),
      null,
    );
    assert.equal(wakes, 0);
    reject = false;
    await f.boundary.execute(f.caller(), f.claimCommand());
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(wakes, 1);
    assert.equal(
      (await f.db.query("SELECT * FROM owner_alarms")).rows.length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("Action completion retains output only in lifecycle body, not durable receipt intent", async () => {
  const f = await fixture();
  try {
    await f.worker().execute(f.hint());
    const receipts = await f.db.query(
      "SELECT * FROM owner_receipts WHERE kind='execution.complete'",
    );
    assert.equal(receipts.rows.length, 1);
    assert.equal(JSON.stringify(receipts.rows).includes("hello world!"), false);
    const terminal = await createActionLifecycleLoader({ store: f.store })(
      "space",
      "run:action:terminal",
    );
    assert.equal(terminal?.status, "completed");
    assert(terminal && terminal.status === "completed");
    assert.equal(
      (terminal.output as { message: string }).message,
      "hello world!",
    );
  } finally {
    await f.close();
  }
});

test("completion digest canonicalizes ordered facts and refuses direct execution or wrong identity", async () => {
  const f = await fixture();
  try {
    const value = {
      namespace: "space",
      executionId: "run",
      completion: { status: "completed", output: { a: 1, b: { x: 2, y: 3 } } },
    };
    const first = await f.normalizeCompletion(value);
    const reordered = await f.normalizeCompletion({
      completion: { output: { b: { y: 3, x: 2 }, a: 1 }, status: "completed" },
      executionId: "run",
      namespace: "space",
    });
    assert.deepEqual(first.intent, reordered.intent);
    for (
      const completion of [
        { status: "completed", output: { a: 2, b: { x: 2, y: 3 } } },
        { status: "failed", code: "action_failed" },
        { status: "failed", code: "effect_indeterminate" },
        { status: "cancelled", code: "action_cancelled" },
      ] as OwnerJson[]
    ) {
      const changed = await f.normalizeCompletion({ ...value, completion });
      assert.notDeepEqual(changed.intent, first.intent);
    }
    await f.boundary.execute(f.caller(), f.claimCommand());
    const command = f.completeCommand({
      status: "failed",
      code: "action_failed",
    });
    await assert.rejects(f.boundary.execute(f.caller(), {
      kind: command.kind,
      domain: command.domain,
      key: command.key,
      intent: first.intent,
    }));
    for (const field of ["namespace", "executionId"]) {
      await assert.rejects(f.boundary.executeInput(f.caller(), {
        ...command,
        input: {
          ...command.input as Record<string, OwnerJson>,
          [field]: "other",
        },
      }));
    }
    assert.equal(
      (await f.db.query(
        "SELECT * FROM owner_receipts WHERE kind='execution.complete'",
      )).rows.length,
      0,
    );
    assert.equal(
      await createActionLifecycleLoader({ store: f.store })(
        "space",
        "run:action:terminal",
      ),
      null,
    );
  } finally {
    await f.close();
  }
});

test("revoked captured Action input refuses new effect begin while restricted settlement remains", async () => {
  const f = await fixture();
  try {
    await f.port().claim(f.hint(), {});
    await f.port().project(f.reference(), {});
    const write = createOwnerTransactionPlanner({
      collections: f.registry.collections,
      identity: {
        ownerId: "owner",
        workerId: f.caller().workerId,
        invocationId: "run",
      },
      execute: (command, options) =>
        f.boundary.execute(f.caller(), command, options),
    });
    const mutation = (key: string) =>
      write({
        operationKey: `root/work/${key}`,
        execute: async (ctx) => {
          await ctx.collections.notes.create({ id: key, title: "safe" });
        },
      });
    await mutation("before-revocation");
    const prior = await f.effects().begin("before-revocation");
    assert.equal(prior.status, "proceed");
    await f.set("input_granted", false);
    await assert.rejects(
      mutation("before-revocation"),
      /input authorization revoked/,
    );
    await assert.rejects(
      mutation("after-revocation"),
      /input authorization revoked/,
    );
    await assert.rejects(
      () => f.effects().begin("before-revocation"),
      /input authorization revoked/,
    );
    await assert.rejects(
      () => f.effects().begin("after-revocation"),
      /input authorization revoked/,
    );
    assert.equal(
      (await f.db.query(
        "SELECT 1 FROM owner_receipts WHERE kind='effect.begin'",
      )).rows.length,
      1,
    );
    await f.effects().confirm("before-revocation", { providerId: "safe" });
    await f.boundary.executeInput(
      f.caller(),
      f.completeCommand({ status: "failed", code: "action_failed" }),
    );
  } finally {
    await f.close();
  }
});
