/**
 * Push notifications' devices: a person turns them on for a browser (the
 * same browser again is one device), lists their own devices and nobody
 * else's, never sees an endpoint or its keys, and turns any of theirs off.
 * Agents reach none, writes go only through the Actions, and an app without
 * a key pair has push off.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { type Actor, createRuntime, defineAction, definePlugin } from "../../../../runtime/mod.ts";
import { memoryStore } from "../../../../stores/memory/mod.ts";
import { test, TEST_ACTOR, testWho } from "../../../../testing/mod.ts";
import { push } from "../mod.ts";

const ana: Actor = { kind: "person", id: "ana" };
const bob: Actor = { kind: "person", id: "bob" };
const agent: Actor = { kind: "agent", id: "helper" };

const KEYS = {
  publicKey: "BP" + "A".repeat(85),
  privateKey: "B".repeat(43),
  contact: "mailto:ops@example.com",
};
const subscription = (n: number) => ({
  endpoint: `https://push.example.com/send/${n}`,
  keys: { p256dh: "B" + "x".repeat(86), auth: "a".repeat(22) },
  expirationTime: null,
});

/** An outsider's own read or write, at the app's REST API, as `actor`. */
const rest = (
  rt: Awaited<ReturnType<typeof createRuntime>>,
  actor: Actor,
  method: string,
  body?: unknown,
) =>
  rt.fetch(
    new Request("http://127.0.0.1/api/collections/pushSubscription", {
      method,
      headers: { [TEST_ACTOR]: JSON.stringify(actor), "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

async function setup(
  fn: (rt: Awaited<ReturnType<typeof createRuntime>>) => Promise<void>,
  settings: Record<string, string> = KEYS,
) {
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [push, testWho, definePlugin({ name: "app", resources: { push: settings } })],
  });
  try {
    await fn(rt);
  } finally {
    await rt.close();
  }
}

const mine = (rt: Awaited<ReturnType<typeof createRuntime>>, actor: Actor) =>
  rt.query<{ id: string; device?: string; at: string }[]>("pushSubscription.mine", {}, { actor });

test("a person turns notifications on per device, and sees only their own", async () => {
  await setup(async (rt) => {
    assertEquals(await rt.call("push.key", {}, { actor: ana }), { key: KEYS.publicKey });
    const first = await rt.call<{ id: string }>("push.subscribe", {
      ...subscription(1),
      device: "iPhone",
    }, { actor: ana });
    // The same browser again (keys renewed) is still one device.
    const again = await rt.call<{ id: string }>("push.subscribe", subscription(1), { actor: ana });
    assertEquals(again.id, first.id);
    await rt.call("push.subscribe", { ...subscription(2), device: "Mac" }, { actor: ana });
    await rt.call("push.subscribe", { ...subscription(3), device: "Android" }, { actor: bob });
    const anas = await mine(rt, ana);
    assertEquals(anas.length, 2);
    assertEquals(anas.map((d) => d.device ?? "").sort(), ["", "Mac"]);
    assertEquals((await mine(rt, bob)).map((d) => d.device), ["Android"]);
    // No read gives an endpoint or its keys, not even the person's own.
    const answer = await rest(rt, ana, "GET");
    assertEquals(answer.status, 200);
    const body = await answer.json() as Record<string, unknown>[] | {
      documents?: Record<string, unknown>[];
    };
    const read = Array.isArray(body) ? body : body.documents ?? [];
    assertEquals(read.length, 2);
    assert(read.every((d) => !("endpoint" in d) && !("keys" in d)));
  });
});

test("a device another person had becomes the new person's", async () => {
  await setup(async (rt) => {
    await rt.call("push.subscribe", subscription(1), { actor: ana });
    await rt.call("push.subscribe", subscription(1), { actor: bob });
    assertEquals((await mine(rt, ana)).length, 0);
    assertEquals((await mine(rt, bob)).length, 1);
  });
});

test("turning off: this browser by its endpoint, another device by its id, only one's own", async () => {
  await setup(async (rt) => {
    await rt.call("push.subscribe", subscription(1), { actor: ana });
    const { id } = await rt.call<{ id: string }>("push.subscribe", subscription(2), { actor: ana });
    assertEquals(
      await rt.call("push.unsubscribe", { id }, { actor: bob }),
      { removed: false },
    );
    assertEquals(await rt.call("push.unsubscribe", { id }, { actor: ana }), { removed: true });
    assertEquals(
      await rt.call("push.unsubscribe", { endpoint: subscription(1).endpoint }, { actor: ana }),
      { removed: true },
    );
    assertEquals((await mine(rt, ana)).length, 0);
  });
});

test("agents reach nobody's devices, and nobody writes them but the Actions", async () => {
  await setup(async (rt) => {
    await rt.call("push.subscribe", subscription(1), { actor: ana });
    await assertRejects(() => rt.call("push.subscribe", subscription(2), { actor: agent }));
    // An agent working for Ana doesn't list her devices either.
    assertEquals(await mine(rt, { ...agent, for: ana }), []);
    const written = await rest(rt, ana, "POST", { person: "ana", at: new Date().toISOString() });
    assertEquals(written.status, 403);
    await written.body?.cancel();
    assertEquals((await mine(rt, ana)).length, 1);
  });
});

test("an endpoint must be a push service's https address", async () => {
  await setup(async (rt) => {
    await assertRejects(() =>
      rt.call("push.subscribe", { ...subscription(1), endpoint: "http://push.example.com/1" }, {
        actor: ana,
      })
    );
    await assertRejects(() =>
      rt.call("push.subscribe", { ...subscription(1), endpoint: "javascript:alert(1)" }, {
        actor: ana,
      })
    );
  });
});

test("without a key pair, push is off: no key to subscribe with, and subscribing says so", async () => {
  await setup(async (rt) => {
    assertEquals(await rt.call("push.key", {}, { actor: ana }), { key: null });
    await assertRejects(() => rt.call("push.subscribe", subscription(1), { actor: ana }));
  }, {});
});

test("a half-given pair, or a pair without a contact, doesn't start", async () => {
  for (const settings of [{ publicKey: KEYS.publicKey }, { ...KEYS, contact: "ops@example.com" }]) {
    await assertRejects(() =>
      createRuntime({
        store: memoryStore(),
        plugins: [push, definePlugin({ name: "app", resources: { push: settings } })],
      })
    );
  }
});
