import { externalEffect } from "./external-effect.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createActionEffectController } from "./effects.ts";
import type { ActionContext, ActionReconcileResult } from "./types.ts";
import type { ActionEffectState as OwnerEffectState } from "./types.ts";

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
  decorateContext?(context: ActionContext): void;
} = {}) {
  let state: OwnerEffectState = input.state ?? { status: "none" };
  let begins = 0;
  let settlements = 0;
  let projections = 0;
  let authorized = true;
  const control = new AbortController();
  const context = { signal: control.signal } as ActionContext;
  input.decorateContext?.(context);
  const controller = createActionEffectController({
    signal: control.signal,
    check() {
      if (!authorized) throw new Error("revoked");
    },
    context: () => context,
    track: (start) => start(),
    reconcile: input.reconcile,
    client: {
      inventory: () => Promise.resolve([]),
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
  const effect = controller.effect;
  Object.assign(context, { effect });
  return {
    effect,
    recover: controller.recover,
    control,
    revoke() {
      authorized = false;
    },
    stats: () => ({ begins, settlements, projections }),
  };
}

test("racing begins grant proceed once and refuse concurrent reconciliation", async () => {
  const entered = deferred();
  const gate = deferred();
  let reconciles = 0;
  const f = fixture({
    reconcile: async () => {
      reconciles++;
      entered.resolve();
      await gate.promise;
      return { status: "confirmed", outcome: null };
    },
  });
  assert.deepEqual(await f.effect.begin("send"), { status: "proceed" });
  const pending = f.effect.begin("send");
  await entered.promise;
  await assert.rejects(f.effect.begin("send"), {
    code: "effect_indeterminate",
  });
  gate.resolve();
  await assert.rejects(pending, { code: "effect_indeterminate" });
  assert.equal(reconciles, 1);
  assert.equal(f.stats().settlements, 0);
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

test("recursive cross-step reconciliation refuses without starting another step", async () => {
  let count = 0;
  const f = fixture({
    state: { status: "indeterminate" },
    reconcile: async (_step, ctx) => {
      count++;
      await assert.rejects(ctx.effect.begin("B"), {
        code: "effect_indeterminate",
      });
      return { status: "confirmed", outcome: null };
    },
  });
  await assert.rejects(f.effect.begin("A"), { code: "effect_indeterminate" });
  assert.equal(count, 1);
  assert.equal(f.stats().begins, 1);
  assert.equal(f.stats().settlements, 0);
});

test("preflight recovery never begins or grants proceed and leaves closed steps closed", async () => {
  for (
    const state of [{ status: "indeterminate" }, {
      status: "replay",
      outcome: null,
    }, { status: "not_started" }] as const
  ) {
    const f = fixture({
      state,
      reconcile: () => Promise.resolve({ status: "confirmed", outcome: null }),
    });
    assert.equal(await f.recover("send"), undefined);
    assert.equal(f.stats().begins, 0);
  }
  const absent = fixture();
  await assert.rejects(absent.recover("missing"), {
    code: "effect_indeterminate",
  });
  assert.equal(absent.stats().begins, 0);
});

test("authored reconcile cannot receive private controller ports as this", async () => {
  let receiver: unknown;
  let state: "begun" | "confirmed" = "begun";
  const controller = createActionEffectController({
    signal: new AbortController().signal,
    check() {},
    track: (run) => run(),
    context: () => ({} as ActionContext),
    client: {
      inventory: () => Promise.resolve([]),
      begin: () => Promise.resolve({ status: "indeterminate" as const }),
      inspect: () =>
        Promise.resolve(
          state === "begun"
            ? { status: "indeterminate" as const }
            : { status: "replay" as const, outcome: null },
        ),
      confirm() {
        state = "confirmed";
        return Promise.resolve();
      },
      notStarted() {
        return Promise.resolve();
      },
    },
    reconcile(this: unknown) {
      receiver = this;
      return { status: "confirmed", outcome: null };
    },
  });
  assert.deepEqual(await controller.effect.begin("step"), {
    status: "replay",
    outcome: null,
  });
  assert.equal(
    receiver,
    undefined,
    "reconcile leaked controller options, including raw client and private lifetime check",
  );
});

test("authored reconcile cannot replace the controller private lifetime check", async () => {
  let current = true;
  let state: "begun" | "confirmed" = "begun";
  const controller = createActionEffectController({
    signal: new AbortController().signal,
    check() {
      if (!current) throw new Error("private authority revoked");
    },
    track: (run) => run(),
    context: () => ({} as ActionContext),
    client: {
      inventory: () => Promise.resolve([]),
      begin: () => Promise.resolve({ status: "indeterminate" as const }),
      inspect: () =>
        Promise.resolve(
          state === "begun"
            ? { status: "indeterminate" as const }
            : { status: "replay" as const, outcome: null },
        ),
      confirm() {
        state = "confirmed";
        return Promise.resolve();
      },
      notStarted() {
        return Promise.resolve();
      },
    },
    reconcile(this: unknown) {
      if (this && typeof this === "object" && "check" in this) {
        (this as { check: () => void }).check = () => {};
      }
      current = false;
      return { status: "confirmed", outcome: null };
    },
  });
  await assert.rejects(
    controller.effect.begin("step"),
    /private authority revoked/,
  );
});

test("reconciliation retains nonenumerable protected context capabilities", async () => {
  const protectedResolver = Symbol("protected-source-resolver");
  const resolver = () => "protected-source";
  const f = fixture({
    state: { status: "indeterminate" },
    decorateContext(context) {
      Object.defineProperty(context, protectedResolver, { value: resolver });
    },
    reconcile(_step, context) {
      const descriptor = Object.getOwnPropertyDescriptor(
        context,
        protectedResolver,
      );
      assert.equal(descriptor?.enumerable, false);
      assert.equal(descriptor?.value, resolver);
      assert.equal(descriptor?.value(), "protected-source");
      assert.equal(typeof context.effect.begin, "function");
      return Promise.resolve({
        status: "confirmed",
        outcome: { reference: "verified" },
      });
    },
  });
  assert.deepEqual(await f.effect.begin("send"), {
    status: "replay",
    outcome: { reference: "verified" },
  });
});

test("externalEffect retains the provider result while confirmation waits", async () => {
  const entered = deferred(), release = deferred();
  const value = { reference: "accepted" };
  const f = fixture({
    settle: async () => {
      entered.resolve();
      await release.promise;
    },
  });
  const pending = externalEffect(
    { effect: f.effect, signal: f.control.signal },
    "send",
    () => value,
  );
  await entered.promise;
  value.reference = "mutated";
  release.resolve();
  assert.deepEqual(await pending, { reference: "accepted" });
  assert.deepEqual(await f.effect.inspect("send"), {
    status: "replay",
    outcome: { reference: "accepted" },
  });
});
