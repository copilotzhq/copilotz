import assert from "node:assert/strict";
import { test } from "node:test";
import type { AnyActionDefinition } from "@copilotz/copilotz/actions";
import { createRegisteredActionWorker } from "../../../../runtime/execution/registered-worker.ts";
import {
  at,
  fixture,
} from "../../../../runtime/owner/execution.fixture.test.ts";
import { readOwnerEffectInventory } from "../../../../runtime/owner/effects.ts";
import {
  TELEGRAM_SEND_TEXT_ACTION_ID,
  TELEGRAM_SEND_TEXT_STEP,
  telegramSendTextAction,
} from "./index.ts";
const data = {
  deliveryKey: "delivery",
  channelId: "telegram",
  chatId: "123",
  text: "Hello",
};
const unknown = () =>
  Object.assign(new Error("injected lost owner response"), {
    outcome: "unknown",
  });
async function setup(
  mode:
    | "none"
    | "begin"
    | "before-confirm"
    | "confirm"
    | "terminal"
    | "provider"
    | "revoked",
) {
  const f = await fixture({
    action: telegramSendTextAction as AnyActionDefinition,
    sourceInput: data,
    allowRecovery: (_tx, _binding, actionId) =>
      actionId === TELEGRAM_SEND_TEXT_ACTION_ID,
  });
  let sends = 0;
  let fault = true;
  const worker = () => {
    const port = f.freshPort();
    return createRegisteredActionWorker({
      registry: f.registry,
      owner: {
        ...port,
        effects: {
          ...port.effects,
          async execute(command, options) {
            const result = await port.effects.execute(command, options);
            if (fault && mode === "begin") {
              fault = false;
              throw unknown();
            }
            return result;
          },
          async settle(command, options) {
            if (fault && mode === "before-confirm") {
              fault = false;
              throw unknown();
            }
            const result = await port.effects.settle(command, options);
            if (fault && mode === "confirm") {
              fault = false;
              throw unknown();
            }
            return result;
          },
        },
      },
      createCapabilities: () => ({
        resources: { channels: { telegram: { egress: "external" } } },
        adapters: {
          channelProviders: {
            telegram: {
              config: { botToken: "fixture-only-not-a-credential" },
              fetch: (async () => {
                sends++;
                if (mode === "revoked") await f.set("ctx_granted", false);
                if (mode === "provider") {
                  throw new Error("provider accepted then connection broke");
                }
                return Response.json({
                  ok: true,
                  result: {
                    message_id: 33,
                    text: data.text,
                    token: "must-not-persist",
                  },
                });
              }) as typeof fetch,
            },
          },
        },
      }),
    });
  };
  if (mode === "terminal") f.state.lostCompletion = true;
  return { f, worker, sends: () => sends };
}
async function inventory(f: Awaited<ReturnType<typeof fixture>>) {
  return await readOwnerEffectInventory(f.db, {
    ownerId: "owner",
    schema: "public",
    namespace: "space",
    actionRunId: "run",
  });
}
for (const mode of ["begin", "before-confirm", "confirm"] as const) {
  test(`real owner Telegram ${mode} loss never reuses a dispatch permit`, async () => {
    const h = await setup(mode);
    try {
      await assert.rejects(() => h.worker().execute(h.f.hint()), {
        outcome: "unknown",
      });
      assert.equal(h.sends(), mode === "begin" ? 0 : 1);
      assert.deepEqual(await inventory(h.f), [{
        step: TELEGRAM_SEND_TEXT_STEP,
        status: mode === "confirm" ? "confirmed" : "begun",
      }]);
      h.f.state.time = at(1001);
      await h.f.replace({ workerId: "replacement-worker" });
      const recovered = await h.worker().execute(h.f.hint());
      assert.equal(recovered.status, "executed");
      if (recovered.status === "executed") {
        assert.equal(
          recovered.completion.status,
          mode === "confirm" ? "completed" : "failed",
        );
      }
      assert.equal(h.sends(), mode === "begin" ? 0 : 1);
      const receipts = JSON.stringify(
        (await h.f.db.query(
          "SELECT result FROM owner_receipts WHERE kind LIKE 'effect.%'",
        )).rows,
      );
      assert.equal(receipts.includes("must-not-persist"), false);
      assert.equal(receipts.includes("Hello"), false);
      assert.equal(
        (await h.f.store.getDelivery(h.f.reference().deliveryId))?.attempts,
        2,
      );
    } finally {
      await h.f.close();
    }
  });
}
test("real provider ambiguity preserves begun evidence and creates a fixed failure without resend", async () => {
  const h = await setup("provider");
  try {
    const first = await h.worker().execute(h.f.hint());
    assert.equal(first.status, "executed");
    if (first.status === "executed") {
      assert.deepEqual(first.completion, {
        status: "failed",
        code: "effect_indeterminate",
      });
    }
    assert.equal(h.sends(), 1);
    assert.deepEqual(await inventory(h.f), [{
      step: TELEGRAM_SEND_TEXT_STEP,
      status: "begun",
    }]);
    await h.worker().execute(h.f.hint());
    assert.equal(h.sends(), 1);
  } finally {
    await h.f.close();
  }
});
test("lost Action completion after confirmed provider send recovers a terminal without another request", async () => {
  const h = await setup("terminal");
  try {
    await assert.rejects(() => h.worker().execute(h.f.hint()), {
      outcome: "unknown",
    });
    const replay = await h.worker().execute(h.f.hint());
    assert.equal(replay.status, "replayed");
    assert.equal(h.sends(), 1);
    assert.deepEqual(await inventory(h.f), [{
      step: TELEGRAM_SEND_TEXT_STEP,
      status: "confirmed",
    }]);
  } finally {
    await h.f.close();
  }
});

test("provider confirmation and terminal survive ctx revocation under narrow settlement authority", async () => {
  const h = await setup("revoked");
  try {
    const done = await h.worker().execute(h.f.hint());
    assert.equal(done.status, "executed");
    if (done.status === "executed") {
      assert.equal(done.completion.status, "completed");
    }
    assert.equal(h.sends(), 1);
    assert.deepEqual(await inventory(h.f), [{
      step: TELEGRAM_SEND_TEXT_STEP,
      status: "confirmed",
    }]);
  } finally {
    await h.f.close();
  }
});
