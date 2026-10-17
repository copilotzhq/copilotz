import assert from "node:assert/strict";
import { test } from "node:test";
import { defineAction } from "../actions/define.ts";
import type { ActionContext, AnyActionDefinition } from "../actions/types.ts";
import { createActionLifecycleLoader } from "../actions/persistence.ts";
import { createOwnerTransactionPlanner } from "./transaction.ts";
import { readOwnerEffectInventory } from "./effects.ts";
import { at, fixture } from "./execution.fixture.test.ts";

const scope = {
  ownerId: "owner",
  schema: "public",
  namespace: "space",
  actionRunId: "run",
};
async function lost(f: Awaited<ReturnType<typeof fixture>>) {
  f.state.time = at(1001);
  await f.replace({ workerId: "replacement-worker" });
}
function mutation(f: Awaited<ReturnType<typeof fixture>>) {
  return createOwnerTransactionPlanner({
    collections: f.registry.collections,
    identity: {
      ownerId: "owner",
      invocationId: "run",
    },
    execute: (command, options) =>
      f.boundary.execute(f.caller(), command, options),
  })({
    operationKey: "root/work/recovery-write",
    execute: async (ctx) => {
      await ctx.collections.notes.create({ id: "recovered", title: "safe" });
    },
  });
}
async function terminal(f: Awaited<ReturnType<typeof fixture>>) {
  return await createActionLifecycleLoader({ store: f.store })(
    "space",
    "run:action:terminal",
  );
}

test("lost unconverted Action refuses replay even with no effect receipts and preserves retry budget", async () => {
  const f = await fixture();
  try {
    await f.port().claim(f.hint(), {});
    await lost(f);
    const result = await f.worker().execute(f.hint());
    assert.equal(result.status, "executed");
    if (result.status === "executed") {
      assert.deepEqual(result.completion, {
        status: "failed",
        code: "effect_indeterminate",
      });
    }
    assert.equal(f.state.executions, 0);
    assert.equal(
      (await f.store.getDelivery(f.reference().deliveryId))?.attempts,
      2,
    );
    assert.equal((await terminal(f))?.status, "failed");
  } finally {
    await f.close();
  }
});

test("owner independently refuses blocked recovery mutation, begin and successful terminal", async () => {
  const f = await fixture();
  try {
    await f.port().claim(f.hint(), {});
    await lost(f);
    await f.port().claim(f.hint(), {});
    assert.deepEqual((await f.port().project(f.reference(), {})).recovery, {
      status: "blocked",
      effects: [],
    });
    await assert.rejects(mutation(f), { code: "effect_indeterminate" });
    await assert.rejects(f.effects().begin("new"), {
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
    assert.equal(await terminal(f), null);
    await f.port().complete(f.reference(), {
      status: "failed",
      code: "effect_indeterminate",
    }, {});
  } finally {
    await f.close();
  }
});

test("converted empty lost run may replay only under current trusted eligibility", async () => {
  let allowed = true;
  const f = await fixture({ allowRecovery: () => allowed });
  try {
    await f.port().claim(f.hint(), {});
    await lost(f);
    await f.port().claim(f.hint(), {});
    assert.deepEqual((await f.port().project(f.reference(), {})).recovery, {
      status: "eligible",
      effects: [],
    });
    allowed = false;
    assert.equal(
      (await f.port().project(f.reference(), {})).recovery?.status,
      "blocked",
    );
    await assert.rejects(mutation(f), { code: "effect_indeterminate" });
    await assert.rejects(f.effects().begin("new"), {
      code: "effect_indeterminate",
    });
    allowed = true;
    await f.port().complete(f.reference(), {
      status: "completed",
      output: { id: "note", message: "safe" },
    }, {});
  } finally {
    await f.close();
  }
});

test("owner barrier requires original begun steps closed but allows new effects after recovery", async () => {
  const f = await fixture({ allowRecovery: () => true });
  try {
    const old = f.effects();
    await f.port().claim(f.hint(), {});
    assert.equal((await old.begin("old")).status, "proceed");
    await lost(f);
    await f.port().claim(f.hint(), {});
    assert.deepEqual((await f.port().project(f.reference(), {})).recovery, {
      status: "eligible",
      effects: [{ step: "old", status: "begun" }],
    });
    await assert.rejects(mutation(f), { code: "effect_indeterminate" });
    await assert.rejects(f.effects().begin("new"), {
      code: "effect_indeterminate",
    });
    await assert.rejects(old.confirm("old", null), {
      code: "ActionOwnershipLost",
    });
    await f.effects().confirm("old", null);
    await mutation(f);
    assert.equal((await f.effects().begin("new")).status, "proceed");
    await assert.rejects(
      f.port().complete(
        f.reference(),
        { status: "completed", output: null },
        {},
      ),
      { code: "effect_indeterminate" },
    );
    await f.effects().confirm("new", { reference: "safe" });
    await f.port().complete(f.reference(), {
      status: "completed",
      output: { id: "note", message: "safe" },
    }, {});
    assert.deepEqual(await readOwnerEffectInventory(f.db, scope), [{
      step: "new",
      status: "confirmed",
    }, { step: "old", status: "confirmed" }]);
  } finally {
    await f.close();
  }
});

test("worker reconciles old effect before execute and cannot receive a second proceed", async () => {
  const order: string[] = [];
  const action = defineAction({
    id: "fixture.work",
    execute: async (_input: unknown, ctx: ActionContext) => {
      order.push("execute");
      assert.deepEqual(await ctx.effect.begin("send"), {
        status: "replay",
        outcome: { id: "external" },
      });
      return "done";
    },
    reconcile: (step) => {
      order.push(`reconcile:${step}`);
      return { status: "confirmed", outcome: { id: "external" } };
    },
  }) as AnyActionDefinition;
  const f = await fixture({ action, allowRecovery: () => true });
  try {
    await f.port().claim(f.hint(), {});
    await f.effects().begin("send");
    await lost(f);
    const result = await f.worker().execute(f.hint());
    assert.equal(result.status, "executed");
    if (result.status === "executed") {
      assert.equal(result.completion.status, "completed");
    }
    assert.deepEqual(order, ["reconcile:send", "execute"]);
  } finally {
    await f.close();
  }
});

test("missing or unresolved reconciliation refuses business execution and retains begun evidence", async () => {
  for (const declared of [false, true]) {
    let executed = false;
    const action = defineAction({
      id: "fixture.work",
      execute: () => {
        executed = true;
        return null;
      },
      ...(declared
        ? { reconcile: () => ({ status: "indeterminate" as const }) }
        : {}),
    }) as AnyActionDefinition;
    const f = await fixture({ action, allowRecovery: () => true });
    try {
      await f.port().claim(f.hint(), {});
      await f.effects().begin("send");
      await lost(f);
      const result = await f.worker().execute(f.hint());
      if (result.status === "executed") {
        assert.deepEqual(result.completion, {
          status: "failed",
          code: "effect_indeterminate",
        });
      } else assert.fail("must produce known failed terminal");
      assert.equal(executed, false);
      assert.deepEqual(await readOwnerEffectInventory(f.db, scope), [{
        step: "send",
        status: "begun",
      }]);
    } finally {
      await f.close();
    }
  }
});

test("first-attempt unfinished effect forbids success and ordinary failure preserves uncertainty", async () => {
  const f = await fixture();
  try {
    await f.port().claim(f.hint(), {});
    await f.effects().begin("send");
    await assert.rejects(
      f.port().complete(
        f.reference(),
        { status: "completed", output: null },
        {},
      ),
      { code: "effect_indeterminate" },
    );
    assert.equal(await terminal(f), null);
    await f.port().complete(f.reference(), {
      status: "failed",
      code: "action_failed",
    }, {});
    assert.deepEqual(await readOwnerEffectInventory(f.db, scope), [{
      step: "send",
      status: "begun",
    }]);
  } finally {
    await f.close();
  }
});

test("recovery settlement survives ctx revocation but not assignment or settlement loss", async () => {
  const f = await fixture({ allowRecovery: () => true });
  try {
    await f.port().claim(f.hint(), {});
    await f.effects().begin("send");
    await lost(f);
    await f.port().claim(f.hint(), {});
    await f.set("ctx_granted", false);
    await f.effects().notStarted("send", {
      source: "fixture",
      reference: "verified-no-start",
    });
    assert.deepEqual(await f.effects().inspect("send"), {
      status: "not_started",
    });
    await f.set("settlement_granted", false);
    await assert.rejects(f.effects().inspect("send"), {
      code: "ActionOwnershipLost",
    });
    await f.set("settlement_granted", true);
    await f.set("live", false);
    await assert.rejects(f.effects().inspect("send"), {
      code: "ActionOwnershipLost",
    });
  } finally {
    await f.close();
  }
});

test("captured blocked eligibility cannot be upgraded and missing claim barrier cannot grant recovery", async () => {
  let allowed = false;
  const f = await fixture({ allowRecovery: () => allowed });
  try {
    await f.port().claim(f.hint(), {});
    await lost(f);
    await f.port().claim(f.hint(), {});
    allowed = true;
    assert.equal(
      (await f.port().project(f.reference(), {})).recovery?.status,
      "blocked",
    );
    await assert.rejects(mutation(f), { code: "effect_indeterminate" });
    await f.db.query(
      "UPDATE owner_receipts SET result=result-'recovery' WHERE key=$1",
      [f.claimCommand().key],
    );
    await assert.rejects(f.port().project(f.reference(), {}), {
      code: "effect_indeterminate",
    });
    await assert.rejects(f.effects().begin("new"), {
      code: "effect_indeterminate",
    });
  } finally {
    await f.close();
  }
});

test("eligibility policy cannot mutate private claim or projection authority", async () => {
  let observedActionId: unknown;
  const f = await fixture({
    allowRecovery(_tx, assignment, actionId) {
      observedActionId = actionId;
      (assignment as { deliveryId: string }).deliveryId = "forged-delivery";
      (assignment.invocation as { actionRunId: string }).actionRunId =
        "forged-run";
      return true;
    },
  });
  try {
    await f.port().claim(f.hint(), {});
    await lost(f);
    const expected = f.reference();
    assert.deepEqual((await f.port().claim(f.hint(), {})).result, expected);
    assert.equal(observedActionId, "fixture.work");
    const projected = await f.port().project(expected, {});
    assert.equal(projected.invocation.actionRunId, "run");
    await f.effects().begin("send");
  } finally {
    await f.close();
  }
});

test("input policy receives detached capture, projection and assignment data", async () => {
  const f = await fixture({
    sourceInput: { nested: { value: "original" } },
    action: defineAction({
      id: "fixture.work",
      execute: () => null,
    }) as AnyActionDefinition,
    inputPolicy(_tx, assignment, value) {
      (assignment as { deliveryId: string }).deliveryId = "forged-delivery";
      (assignment.invocation as { actionRunId: string }).actionRunId =
        "forged-run";
      (value as { nested: { value: string } }).nested.value = "forged-input";
    },
  });
  try {
    const expected = f.reference();
    assert.deepEqual((await f.port().claim(f.hint(), {})).result, expected);
    const projected = await f.port().project(expected, {});
    assert.deepEqual(projected.input, { nested: { value: "original" } });
    assert.equal(projected.invocation.actionRunId, "run");
    const captured = await createActionLifecycleLoader({ store: f.store })(
      "space",
      "run:action:invoked",
    );
    assert.equal(captured?.status, "invoked");
    if (captured?.status === "invoked") {
      assert.deepEqual(captured.input, { nested: { value: "original" } });
    }
  } finally {
    await f.close();
  }
});
