import assert from "node:assert/strict";
import { test } from "node:test";
import { defineAction } from "../actions/define.ts";
import { createActionLifecycleLoader } from "../actions/persistence.ts";
import type { AnyActionDefinition } from "../actions/types.ts";
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

test("clock passage grants no replacement; stale assignment and epoch cannot hydrate or settle", async () => {
  const f = await fixture();
  try {
    const oldCaller = f.caller(),
      oldPort = f.port(oldCaller),
      oldRef = f.reference();
    await oldPort.claim(f.hint(), {});
    f.state.time = at(120_000);
    assert.equal((await oldPort.project(oldRef, {})).input, "world");
    await f.replace();
    await assert.rejects(f.port().claim(f.hint(), {}), {
      code: "ActionOwnershipLost",
    });
    assert.equal((await f.store.getDelivery(oldRef.deliveryId))?.attempts, 1);
    await assert.rejects(oldPort.project(oldRef, {}), {
      code: "ActionOwnershipLost",
    });
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

test("captured input survives source changes; an unretired replacement cannot reuse it", async () => {
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
    await assert.rejects(f.port().claim(f.hint(), {}), {
      code: "ActionOwnershipLost",
    });
    await assert.rejects(f.port().project(f.reference(), {}));
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

test("worker remains current beyond former lease interval without renewal receipts", async () => {
  const entered = deferred(), release = deferred();
  const f = await fixture({
    afterAction: async () => {
      entered.resolve();
      await release.promise;
    },
  });
  try {
    const pending = f.worker().execute(f.hint());
    await within(entered.promise);
    assert.equal(
      (await f.store.getDelivery(f.reference().deliveryId))?.leaseExpiresAt,
      undefined,
    );
    f.state.time = at(120_000);
    assert.equal((await f.port().project(f.reference(), {})).input, "world");
    release.resolve();
    assert.equal((await within(pending)).receipt.status, "completed");
    assert.equal(
      (await f.db.query(
        "SELECT 1 FROM owner_receipts WHERE kind='execution.renew'",
      )).rows.length,
      0,
    );
    assert.equal(f.state.executions, 1);
  } finally {
    release.resolve();
    await f.close();
  }
});

test("revoked ctx refuses next command while narrow settlement remains available without polling", async () => {
  const entered = deferred(), release = deferred();
  const f = await fixture({
    afterAction: async (ctx) => {
      entered.resolve();
      await release.promise;
      await ctx.transaction(async ({ collections }) => {
        await collections.notes.create({
          id: "after-revoke",
          title: "must refuse",
        });
      }, { operationKey: "after-revoke" });
    },
  });
  try {
    const pending = f.worker().execute(f.hint());
    await within(entered.promise);
    await f.set("ctx_granted", false);
    release.resolve();
    assert.equal((await within(pending)).receipt.status, "failed");
    assert.equal(
      f.state.collectionAttempts,
      2,
      "both calls reached owner authorization",
    );
    assert.equal(
      (await f.db.query("SELECT 1 FROM nodes WHERE id='after-revoke'")).rows
        .length,
      0,
    );
    assert.equal(f.state.executions, 1);
    assert.equal((await f.db.query("SELECT id FROM nodes")).rows.length, 1);
  } finally {
    release.resolve();
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

test("owner Action claim and completion schedule settlement atomically, but duplicate commands do not", async () => {
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
