/**
 * Renaming a conversation (`chat.rename`): by a person who may write in its
 * space, for everyone there to read; not by a viewer, someone outside, an
 * agent or a contact. A contact's chat and its notes keep one title, and a
 * name someone gave stays: the agent that might have named the chat no
 * longer does.
 */
import { assertEquals } from "@std/assert";
import { type Actor, createRuntime, definePlugin, type Runtime } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models, { type LlmAdapter } from "../../models/mod.ts";
import { chat, type Thread } from "../mod.ts";
import { access } from "../../access/mod.ts";
import { test } from "../../../testing/mod.ts";
import { join } from "../../access/tests/join.ts";

const ana: Actor = { kind: "person", id: "ana" };
const bob: Actor = { kind: "person", id: "bob" };
const eve: Actor = { kind: "person", id: "eve" };
const carla: Actor = { kind: "contact", id: "c-carla-01" };

const answers: LlmAdapter = {
  async *generate() {
    yield { type: "text", text: "noted" };
  },
};

const app = definePlugin({
  name: "app",
  resources: {
    provider: { e: { adapter: "e" } },
    agents: { lead: { instructions: "Help.", model: "e/lead", default: true } },
  },
  adapters: { llm: { e: answers } },
});

const probe = definePlugin({
  name: "probe",
  views: {
    thread: (
      filter: Record<string, unknown> | undefined,
      ctx: { db: { collection(n: string): { find(f: unknown): { value?: unknown } } } },
    ) => ctx.db.collection("thread").find(filter ?? {}).value ?? [],
  },
});

type Setup = { runtime: Runtime; shop: string; plan: string; carlas: string };

/** Shop, where Bob writes and Eve only reads; Ana's chat there, and Carla's (a contact). */
async function setup(fn: (s: Setup) => Promise<void>) {
  const runtime = await createRuntime({
    store: memoryStore(),
    plugins: [models, chat, ...access, app, probe],
  });
  try {
    const { space: shop } = await runtime.call<{ space: string }>("space.create", {
      name: "Shop",
    }, { actor: ana });
    await join(runtime, shop, bob, "editor", ana);
    await join(runtime, shop, eve, "viewer", ana);
    const { thread: plan } = await runtime.call<{ thread: string }>("chat.send", {
      in: shop,
      text: "the plan for the quarter",
    }, { actor: ana });
    await runtime.call("contact.start", { id: carla.id, in: shop, via: "whatsapp", name: "Carla" });
    const { thread: carlas } = await runtime.call<{ thread: string }>("contact.chat", {
      contact: carla.id,
      in: shop,
    });
    await runtime.call("chat.send", { thread: carlas, text: "where's my order?" }, {
      actor: carla,
    });
    await runtime.idle();
    await fn({ runtime, shop, plan, carlas });
  } finally {
    await runtime.close();
  }
}

/** A thread as `actor` reads it, as a page would. */
const read = async (runtime: Runtime, actor: Actor, id: string) => {
  const seen = runtime.observe<Thread[]>("thread", { _id: id }, { actor });
  const output = await seen.ready;
  seen.close();
  return output.status === "ready" ? output.value[0] : undefined;
};

const code = (p: Promise<unknown>) =>
  p.then(() => "done", (e) => (e as { code?: string }).code ?? String(e));

test("a person who writes in its space renames a chat, for everyone there to read", async () => {
  await setup(async ({ runtime, plan }) => {
    assertEquals(
      await runtime.call("chat.rename", { thread: plan, title: "  Q3   plan " }, { actor: bob }),
      { thread: plan, title: "Q3 plan" },
    );
    for (const who of [ana, bob, eve]) {
      assertEquals((await read(runtime, who, plan))?.title, "Q3 plan");
    }
  });
});

test("a viewer, someone outside, an agent and a contact don't rename it", async () => {
  await setup(async ({ runtime, plan, carlas }) => {
    const before = [
      (await read(runtime, ana, plan))?.title,
      (await read(runtime, ana, carlas))?.title,
    ];
    const rename = (actor: Actor, thread = plan) =>
      code(runtime.call("chat.rename", { thread, title: "Mine" }, { actor }));
    assertEquals(await rename(eve), "forbidden");
    assertEquals(await rename({ kind: "person", id: "zoe" }), "not_found");
    assertEquals(await rename({ kind: "agent", id: "lead", for: ana }), "forbidden");
    assertEquals(await rename(carla, carlas), "forbidden");
    assertEquals(
      await code(runtime.call("chat.rename", { thread: plan, title: "   " }, {
        actor: ana,
      })),
      "invalid",
    );
    // Nothing renamed: Ana's chat is still untitled, and Carla's has her name.
    assertEquals(before, [undefined, "Carla"]);
    assertEquals(
      [(await read(runtime, ana, plan))?.title, (await read(runtime, ana, carlas))?.title],
      before,
    );
  });
});

test("a contact's chat and its notes keep one title, renamed from either", async () => {
  await setup(async ({ runtime, carlas }) => {
    const { thread: notes } = await runtime.call<{ thread: string }>("chat.notes", {
      thread: carlas,
    }, { actor: bob });
    await runtime.call("chat.rename", { thread: carlas, title: "Carla's late order" }, {
      actor: bob,
    });
    assertEquals((await read(runtime, bob, notes))?.title, "Carla's late order");
    // Renaming the notes renames the chat they're about.
    assertEquals(
      await runtime.call("chat.rename", { thread: notes, title: "Refund" }, { actor: ana }),
      { thread: carlas, title: "Refund" },
    );
    assertEquals((await read(runtime, ana, carlas))?.title, "Refund");
    assertEquals((await read(runtime, ana, notes))?.title, "Refund");
  });
});

test("a name someone gave stays: an agent that might name the chat no longer does", async () => {
  await setup(async ({ runtime, shop }) => {
    const { thread } = await runtime.call<{ thread: string }>("chat.send", {
      in: shop,
      text: "competitors' prices",
      title: "Run",
      renamable: true,
    }, { actor: ana });
    await runtime.idle();
    assertEquals((await read(runtime, ana, thread))?.renamable, true);
    await runtime.call("chat.rename", { thread, title: "Prices, Nov" }, { actor: ana });
    const renamed = await read(runtime, ana, thread);
    assertEquals([renamed?.title, renamed?.renamable], ["Prices, Nov", undefined]);
  });
});
