import assert from "node:assert/strict";
import { test } from "node:test";
import { createActionEffectCapability } from "./effects.ts";
import type { ActionContext, ActionReconcileResult } from "./types.ts";
import type { OwnerEffectState } from "../owner/effects-client.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => resolve = done);
  return { promise, resolve };
}
function fixture(input: {
  state?: OwnerEffectState;
  reconcile?: (
    step: string,
    ctx: ActionContext,
  ) => Promise<ActionReconcileResult>;
  settle?: () => Promise<void>;
} = {}) {
  let state: OwnerEffectState = input.state ?? { status: "none" };
  let begins = 0;
  let settlements = 0;
  let projections = 0;
  let authorized = true;
  const control = new AbortController();
  const context = { signal: control.signal } as ActionContext;
  const effect = createActionEffectCapability({
    signal: control.signal,
    check() {
      if (!authorized) throw new Error("revoked");
    },
    context: () => context,
    track: (start) => start(),
    reconcile: input.reconcile,
    client: {
      begin() {
        begins++;
        if (state.status === "none") {
          state = { status: "indeterminate" };
          return Promise.resolve({ status: "proceed" as const });
        }
        return Promise.resolve(structuredClone(state));
      },
      inspect() {
        projections++;
        return Promise.resolve(structuredClone(state));
      },
      async confirm(_step, outcome) {
        settlements++;
        await input.settle?.();
        state = { status: "replay", outcome };
      },
      async notStarted() {
        settlements++;
        await input.settle?.();
        state = { status: "not_started" };
      },
    },
  });
  Object.assign(context, { effect });
  return {
    effect,
    control,
    revoke() {
      authorized = false;
    },
    stats: () => ({ begins, settlements, projections }),
  };
}

test("same-step racing begin grants proceed once and coalesces only reconciliation", async () => {
  const gate = deferred();
  let reconciles = 0;
  const f = fixture({
    reconcile: async () => {
      reconciles++;
      await gate.promise;
      return { status: "confirmed", outcome: { reference: "durable" } };
    },
  });
  const calls = [
    f.effect.begin("send"),
    f.effect.begin("send"),
    f.effect.begin("send"),
  ];
  assert.deepEqual(await calls[0], { status: "proceed" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(reconciles, 1);
  gate.resolve();
  assert.deepEqual(await Promise.all(calls.slice(1)), [
    { status: "replay", outcome: { reference: "durable" } },
    { status: "replay", outcome: { reference: "durable" } },
  ]);
  assert.equal(f.stats().begins, 3);
  assert.equal(f.stats().settlements, 1);
});

test("missing or unresolved reconciliation fails fixed effect_indeterminate without dispatch permission", async () => {
  for (
    const reconcile of [
      undefined,
      () => Promise.resolve({ status: "indeterminate" as const }),
    ]
  ) {
    const f = fixture({ state: { status: "indeterminate" }, reconcile });
    await assert.rejects(f.effect.begin("send"), {
      code: "effect_indeterminate",
    });
    await assert.rejects(f.effect.begin("send"), {
      code: "effect_indeterminate",
    });
    assert.equal(f.stats().settlements, 0);
  }
});

test("reconciliation closes verified no-start without reopening the same step", async () => {
  let count = 0;
  const f = fixture({
    state: { status: "indeterminate" },
    reconcile: () => {
      count++;
      return Promise.resolve({
        status: "not_started",
        evidence: { source: "dispatch", reference: "receipt" },
      });
    },
  });
  assert.deepEqual(await f.effect.begin("send"), { status: "not_started" });
  assert.deepEqual(await f.effect.begin("send"), { status: "not_started" });
  assert.equal(count, 1);
});

test("same-step recursive reconciliation fails even if the hook catches its refusal", async () => {
  const f = fixture({
    state: { status: "indeterminate" },
    reconcile: async (step, ctx) => {
      await assert.rejects(ctx.effect.begin(step), {
        code: "effect_indeterminate",
      });
      return { status: "confirmed", outcome: "must not settle" };
    },
  });
  await assert.rejects(f.effect.begin("send"), {
    code: "effect_indeterminate",
  });
  assert.equal(f.stats().settlements, 0);
});

test("aborted or revoked reconciliation cannot record a late provider answer", async () => {
  for (const revoke of [false, true]) {
    const entered = deferred();
    const gate = deferred();
    const f = fixture({
      state: { status: "indeterminate" },
      reconcile: async () => {
        entered.resolve();
        await gate.promise;
        return { status: "confirmed", outcome: "late" };
      },
    });
    const pending = f.effect.begin("send");
    await entered.promise;
    if (revoke) f.revoke();
    else f.control.abort();
    gate.resolve();
    await assert.rejects(pending);
    assert.equal(f.stats().settlements, 0);
  }
});

test("lost confirm and no-start replies remain unknown and never repeat reconciliation", async () => {
  for (const status of ["confirmed", "not_started"] as const) {
    const unknown = Object.assign(new Error("lost completion"), {
      indeterminate: true,
    });
    let count = 0;
    const f = fixture({
      state: { status: "indeterminate" },
      reconcile: () => {
        count++;
        return Promise.resolve(
          status === "confirmed"
            ? { status, outcome: "safe" }
            : { status, evidence: { source: "dispatch", reference: "proof" } },
        );
      },
      settle: () => Promise.reject(unknown),
    });
    await assert.rejects(f.effect.begin("send"), (error) => error === unknown);
    await assert.rejects(f.effect.begin("send"), (error) => error === unknown);
    assert.equal(count, 1);
    assert.equal(f.stats().settlements, 1);
  }
});

test("a plain return or forged proceed reconciliation cannot authorize another send", async () => {
  for (
    const result of [null, "sent", { status: "proceed" }, {
      status: "confirmed",
      outcome: "safe",
      extra: true,
    }]
  ) {
    const f = fixture({
      state: { status: "indeterminate" },
      reconcile: () => Promise.resolve(result as never),
    });
    await assert.rejects(f.effect.begin("send"), {
      code: "effect_indeterminate",
    });
    assert.equal(f.stats().settlements, 0);
  }
});

test("concurrent cross-step reconciliation cycles refuse instead of deadlocking", async () => {
  const entered = deferred();
  let count = 0;
  const f = fixture({
    state: { status: "indeterminate" },
    reconcile: async (step, ctx) => {
      if (++count === 2) entered.resolve();
      await entered.promise;
      await assert.rejects(ctx.effect.begin(step === "A" ? "B" : "A"), {
        code: "effect_indeterminate",
      });
      return { status: "confirmed", outcome: "must not settle" };
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const results = await Promise.race([
      Promise.allSettled([f.effect.begin("A"), f.effect.begin("B")]),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("reconciliation cycle deadlocked")),
          500,
        );
      }),
    ]);
    for (const result of results) {
      assert.equal(result.status, "rejected");
      if (result.status === "rejected") {
        assert.equal(result.reason.code, "effect_indeterminate");
      }
    }
    assert.equal(f.stats().settlements, 0);
  } finally {
    clearTimeout(timer);
  }
});
