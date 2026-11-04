/**
 * Memberships read by one's own key: a contact finds its chats so, all of
 * them; anyone else reads memberships as far as they reach, so a key
 * `within` one space reads that space's, never where else its person is.
 */
import { assertEquals } from "@std/assert";
import { type Actor, createRuntime, definePlugin } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models from "../../models/mod.ts";
import { chat } from "../../agents/chat/mod.ts";
import { access } from "../mod.ts";
import { test } from "../../../testing/mod.ts";

const app = definePlugin({
  name: "app",
  resources: {
    agents: { guide: { instructions: "Help.", model: "fake/echo" } },
    spaces: { shop: { name: "Shop", agents: ["guide"] } },
  },
  views: {
    members: {
      test: (f: Record<string, unknown>, ctx) =>
        (ctx.db.collection<{ space: string }>("member").find(f).value ?? []).map((m) => m.space)
          .sort(),
    },
  },
});

test("memberships by one's own key: a contact's all, a key within a space only that space's", async () => {
  const runtime = await createRuntime({
    store: memoryStore(),
    plugins: [models, chat, ...access, app],
  });
  const read = async (actor: Actor, f: Record<string, unknown>) => {
    const observed = runtime.observe<string[]>("test", "members", f, { actor });
    try {
      const out = await observed.ready;
      return out.status === "ready" ? out.value : out;
    } finally {
      observed.close();
    }
  };
  try {
    const ana: Actor = { kind: "person", id: "ana" };
    for (const id of ["s1", "s2", "secret"]) {
      await runtime.call("space.create", { id, name: id }, { actor: ana });
    }
    // Her key within s1: s1's memberships, by her key or not (before: s1, s2 and secret).
    const scoped: Actor = { ...ana, within: "s1" };
    assertEquals(await read(scoped, { member: "person:ana" }), ["s1"]);
    assertEquals(await read(scoped, { space: "secret" }), []);
    // She reads hers everywhere she is.
    assertEquals(await read(ana, { member: "person:ana" }), ["s1", "s2", "secret"]);
    // A contact finds its chats by its key: its own memberships, all of them.
    await runtime.call("space.keep", { id: "shop" });
    await runtime.call("contact.start", { id: "c-carla-01", in: "shop", via: "test" });
    const { thread } = await runtime.call<{ thread: string }>("contact.chat", {
      contact: "c-carla-01",
      in: "shop",
    });
    const carla: Actor = { kind: "contact", id: "c-carla-01" };
    const hers = await read(carla, { member: "contact:c-carla-01" });
    assertEquals(Array.isArray(hers) && hers.includes(`thread:${thread}`), true, String(hers));
    // The agent working for her reads as far as she reaches, not by her key's shortcut.
    const working: Actor = { kind: "agent", id: "guide", for: carla };
    assertEquals(await read(working, { member: "agent:guide" }), []);
  } finally {
    await runtime.close();
  }
});
