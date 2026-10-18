import assert from "node:assert/strict";
import { test } from "node:test";
import type { ActionContext, ActionEffect } from "@copilotz/copilotz/actions";
import { TELEGRAM_SEND_TEXT_STEP, telegramSendTextAction } from "./index.ts";
const data = {
  deliveryKey: "delivery",
  channelId: "telegram",
  chatId: "123",
  text: "Hello",
};
function setup() {
  const calls: { url: string; init?: RequestInit }[] = [];
  const confirmed: unknown[] = [];
  const controller = new AbortController();
  const effect: ActionEffect = {
    begin() {
      return Promise.resolve({ status: "proceed" as const });
    },
    inspect() {
      return Promise.resolve({ status: "none" as const });
    },
    confirm(step, outcome) {
      confirmed.push({ step, outcome });
      return Promise.resolve();
    },
    notStarted() {
      return Promise.reject(new Error("Must not infer no-start"));
    },
  };
  const options = {
    config: { botToken: "test-only" },
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return await Promise.resolve(Response.json({
        ok: true,
        result: {
          message_id: 17,
          text: "private provider payload",
          extra: "discard",
        },
      }));
    }) as typeof fetch,
  };
  const context = {
    namespace: "space",
    signal: controller.signal,
    effect,
    resources: { channels: { telegram: { egress: "external" } } },
    adapters: { channelProviders: { telegram: options } },
  } as unknown as ActionContext;
  return { calls, confirmed, controller, effect, options, context };
}
test("Telegram effect Action sends one bounded request and records only its safe reference", async () => {
  const f = setup();
  const value = await telegramSendTextAction.execute(data, f.context);
  assert.deepEqual(value, { deliveryKey: "delivery", providerId: "17" });
  assert.deepEqual(f.confirmed, [{
    step: TELEGRAM_SEND_TEXT_STEP,
    outcome: value,
  }]);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(JSON.parse(String(f.calls[0].init?.body)), {
    chat_id: "123",
    text: "Hello",
  });
  assert.equal(f.calls[0].init?.signal, f.controller.signal);
});
test("confirmed Telegram outcome replays without provider config or send", async () => {
  const f = setup();
  const expected = { deliveryKey: "delivery", providerId: "27" };
  f.context = {
    ...f.context,
    effect: {
      ...f.effect,
      begin: () =>
        Promise.resolve({ status: "replay" as const, outcome: expected }),
    },
  };
  await assert.doesNotReject(async () =>
    assert.deepEqual(
      await telegramSendTextAction.execute(data, f.context),
      expected,
    )
  );
  assert.equal(f.calls.length, 0);
  assert.equal(f.confirmed.length, 0);
});
test("missing capability, closed step, cancellation, transformed and oversized input all refuse before send", async () => {
  for (
    const kind of [
      "missing",
      "closed",
      "cancelled",
      "transform",
      "oversized",
    ] as const
  ) {
    const f = setup();
    let value = data;
    if (kind === "missing") {
      f.context = {
        ...f.context,
        effect: {
          ...f.effect,
          begin: () => Promise.reject(new Error("Owner effect unavailable")),
        },
      };
    }
    if (kind === "closed") {
      f.context = {
        ...f.context,
        effect: {
          ...f.effect,
          begin: () => Promise.resolve({ status: "not_started" as const }),
        },
      };
    }
    if (kind === "cancelled") f.controller.abort();
    if (kind === "transform") {
      Object.assign(f.options, { transformDelivery: () => null });
    }
    if (kind === "oversized") value = { ...data, text: "x".repeat(4001) };
    await assert.rejects(async () =>
      await telegramSendTextAction.execute(value, f.context)
    );
    assert.equal(f.calls.length, 0, kind);
    assert.equal(f.confirmed.length, 0, kind);
  }
});
test("ambiguous provider failure and malformed response never infer no-start or confirmation", async () => {
  for (const mode of ["network", "http", "malformed"] as const) {
    const f = setup();
    f.options.fetch = (async () => {
      if (mode === "network") throw new Error("lost after provider accepted");
      return await Promise.resolve(
        mode === "http"
          ? new Response("refused", { status: 503 })
          : Response.json({ ok: true, result: { token: "do-not-store" } }),
      );
    }) as typeof fetch;
    await assert.rejects(
      async () => await telegramSendTextAction.execute(data, f.context),
      { code: "effect_indeterminate" },
    );
    assert.equal(f.confirmed.length, 0);
  }
});
test("replayed provider outcome must match captured delivery identity", async () => {
  const f = setup();
  f.context = {
    ...f.context,
    effect: {
      ...f.effect,
      begin: () =>
        Promise.resolve({
          status: "replay" as const,
          outcome: { deliveryKey: "other", providerId: "1" },
        }),
    },
  };
  await assert.rejects(async () =>
    await telegramSendTextAction.execute(data, f.context)
  );
  assert.equal(f.calls.length, 0);
});

test("invalid configuration after begin cannot send, confirm or infer no-start", async () => {
  const f = setup();
  f.options.config.botToken = " ";
  await assert.rejects(
    async () => await telegramSendTextAction.execute(data, f.context),
    { code: "effect_indeterminate" },
  );
  assert.equal(f.calls.length, 0);
  assert.equal(f.confirmed.length, 0);
});
test("Telegram provider request observes cancellation without confirmation", async () => {
  const f = setup();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => started = resolve);
  f.options.fetch =
    ((_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        started();
        assert.ok(init?.signal);
        init.signal.addEventListener(
          "abort",
          () => reject(init.signal?.reason),
          { once: true },
        );
      })) as typeof fetch;
  const pending = telegramSendTextAction.execute(data, f.context);
  await ready;
  f.controller.abort();
  await assert.rejects(async () => await pending, {
    code: "effect_indeterminate",
  });
  assert.equal(f.confirmed.length, 0);
});
