/**
 * Contacts: people outside the org, each in a chat shared with them alone.
 * A contact reaches its chat, what's said and filed in it, and nothing else;
 * the agent working for it reaches exactly that chat, though it works in the
 * whole space; the space's people reach every contact's chat, and taking a
 * contact out cuts them off at once. Every Action and query that admits
 * people stays shut to contacts, but the few opened to them.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type Actor,
  createRuntime,
  defineAction,
  definePlugin,
  peopleOrContacts,
  type Runtime,
  type ViewContext,
} from "../../../runtime/mod.ts";
import { merge } from "../../../runtime/registry.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models, { type LlmAdapter, type LlmRequest } from "../../models/mod.ts";
import {
  chat,
  history,
  memory,
  type Message,
  routines,
  skills,
  team,
  type Thread,
  tiers,
  tool,
} from "../../agents/mod.ts";
import { access, accounts, contactOf, directory, googleSignIn } from "../mod.ts";
import { api, terminalPlugin, whatsapp } from "../../interfaces/mod.ts";
import { apps, cloud, computers } from "../../compute/mod.ts";
import { credits, stripe, stripeWebhook, usage } from "../../billing/mod.ts";
import { test } from "../../../testing/mod.ts";

const ana: Actor = { kind: "person", id: "ana" };
const bob: Actor = { kind: "person", id: "bob" };
const code = (p: Promise<unknown>) =>
  p.then(() => "done", (e) => (e as { code?: string }).code ?? String(e));

/** What agents were sent, and what a tool saw, for each test to look at. */
const sent: LlmRequest[] = [];
let peeked: { threads: string[]; messages: string[]; actor?: Actor } | undefined;

/** Answers what it was told; asked to peek, looks around first. */
const echo: LlmAdapter = {
  async *generate(request) {
    sent.push(request);
    const last = request.messages.at(-1)!;
    if (last.role === "tool") return void (yield { type: "text", text: "looked" });
    const text = "text" in last ? last.text ?? "" : "";
    if (text.includes("peek")) {
      return void (yield { type: "tool_call", call: { id: "p", name: "peek", input: {} } });
    }
    yield { type: "text", text: `heard ${text}` };
  },
};

const peek = tool({
  description: "Looks at what it can read",
  input: { type: "object", properties: {} },
  run: async (_input, ctx) => {
    const threads = await ctx.db.collection<Thread>("thread").find({});
    const messages = await ctx.db.collection<Message>("message").find({});
    peeked = {
      threads: threads.map((t) => t._id).sort(),
      messages: [...new Set(messages.map((m) => m.thread))].sort(),
      ...(ctx.actor ? { actor: ctx.actor } : {}),
    };
    return "seen";
  },
});

/** What someone reads of a collection, as a View; and writes as them, as an Action does. */
const probe = definePlugin({
  name: "probe",
  views: Object.fromEntries(
    ["thread", "message", "file", "contact", "space", "member"].map((c) => [
      c,
      { test: (_: unknown, ctx: ViewContext) => ctx.db.collection(c).find({}).value ?? [] },
    ]),
  ),
  actions: {
    "test.write": defineAction({
      input: { type: "object" },
      allow: peopleOrContacts,
      run: async (ctx, input: { thread?: string; update?: boolean }) => {
        if (input.update) {
          const changed = await ctx.db.collection("message").updateMany({}, {
            $set: { text: "changed" },
          });
          return changed.acknowledged ? changed.modifiedCount : 0;
        }
        await ctx.db.collection("message").insertOne({
          _id: crypto.randomUUID(),
          thread: input.thread,
          from: "x",
          to: [],
          text: "slipped in",
          at: new Date().toISOString(),
        });
        return 1;
      },
    }),
    // Who answers in a space, asked as the caller (chat asks this way).
    "test.roster": defineAction({
      input: { type: "object" },
      allow: peopleOrContacts,
      run: (ctx, input: { space: string }) => ctx.call("space.roster", { space: input.space }),
    }),
  },
});

const app = definePlugin({
  name: "app",
  resources: {
    provider: { e: { adapter: "e" } },
    tools: { peek },
    agents: {
      lead: { instructions: "Sell tickets.", model: "e/lead", default: true, tools: ["peek"] },
      ops: { instructions: "Run things.", model: "e/ops" },
    },
  },
  adapters: { llm: { e: echo } },
});

type Setup = {
  runtime: Runtime;
  shop: string;
  /** Ana's own chat in the shop. */
  staff: string;
  /** Two customers, each with a chat in the shop. */
  carla: Actor;
  dani: Actor;
  carlas: string;
  danis: string;
  read<T>(collection: string, actor: Actor): Promise<T[]>;
};

async function setup(fn: (s: Setup) => Promise<void>) {
  sent.length = 0;
  peeked = undefined;
  const runtime = await createRuntime({
    store: memoryStore(),
    plugins: [models, chat, memory, ...access, probe, app],
  });
  try {
    const { space: shop } = await runtime.call<{ space: string }>("space.create", {
      name: "Shop",
    }, { actor: ana });
    const { thread: staff } = await runtime.call<{ thread: string }>("chat.send", {
      in: shop,
      text: "our margins",
    }, { actor: ana });
    const customer = async (id: string, name: string) => {
      await runtime.call("contact.start", { id, in: shop, via: "whatsapp", name });
      const { thread } = await runtime.call<{ thread: string }>("contact.chat", {
        contact: id,
        in: shop,
      });
      return thread;
    };
    const carlas = await customer("c-carla-01", "Carla");
    const danis = await customer("c-dani-002", "Dani");
    await runtime.idle();
    await fn({
      runtime,
      shop,
      staff,
      carla: { kind: "contact", id: "c-carla-01" },
      dani: { kind: "contact", id: "c-dani-002" },
      carlas,
      danis,
      read: async <T>(collection: string, actor: Actor) => {
        const seen = runtime.observe<T[]>("test", collection, {}, { actor });
        const output = await seen.ready;
        seen.close();
        return output.status === "ready" ? output.value : [];
      },
    });
  } finally {
    await runtime.close();
  }
}

const said = async (runtime: Runtime, thread: string) =>
  (await runtime.query<Message[]>("message.history", { thread }, { actor: ana }))
    .filter((m) => !m.private).map((m) => [m.from, m.text]);

test("a contact reaches its own chat, what's said and filed in it, and nothing else", async () => {
  await setup(async ({ runtime, shop, staff, carla, carlas, danis, read }) => {
    await runtime.call("chat.send", {
      thread: carlas,
      text: "a ticket to Santos",
      files: [{ name: "id.txt", type: "text/plain", data: btoa("RG 12.345") }],
    }, { actor: carla });
    await runtime.idle();
    // Its message is from it, and the agent's answer goes back to it.
    assertEquals(await said(runtime, carlas), [
      ["contact:c-carla-01", "a ticket to Santos"],
      ["lead", "heard Carla: a ticket to Santos\n[file id.txt]\nRG 12.345\n[end of id.txt]"],
    ]);
    const [, answer] = await runtime.query<Message[]>("message.history", { thread: carlas }, {
      actor: ana,
    });
    assertEquals([answer.to, answer.sources], [["contact:c-carla-01"], undefined]);

    // What it reads: its chat, and its own record; nothing of the space, nor of others'.
    const ids = async (collection: string) =>
      (await read<{ _id: string; thread?: string }>(collection, carla)).map((d) =>
        d.thread ?? d._id
      );
    assertEquals(await ids("thread"), [carlas]);
    assertEquals([...new Set(await ids("message"))], [carlas]);
    assertEquals(await ids("file"), [carlas]);
    assertEquals(await ids("contact"), ["c-carla-01"]);
    assertEquals(await read("space", carla), []);
    assertEquals(await read("member", carla), []);

    // Writing anywhere else is refused: another's chat, the staff's, a new one in the space.
    for (const thread of [danis, staff]) {
      assert(
        ["forbidden", "duplicate_key"].includes(
          await code(runtime.call("chat.send", { thread, text: "hi" }, { actor: carla })),
        ),
      );
    }
    assertEquals(
      await code(runtime.call("chat.send", { in: shop, text: "hi" }, { actor: carla })),
      "forbidden",
    );
    assertEquals(
      await code(runtime.call("test.write", { thread: danis }, { actor: carla })),
      "forbidden",
    );
    assertEquals(await runtime.call("test.write", { thread: carlas }, { actor: carla }), 1);
    // An update reaches only its own chat's messages.
    const before = (await said(runtime, staff)).length;
    assertEquals(await runtime.call("test.write", { update: true }, { actor: carla }), 3);
    assertEquals((await said(runtime, staff)).length, before);
    assert((await said(runtime, staff)).every(([, text]) => text !== "changed"));
    assert((await said(runtime, danis)).every(([, text]) => text !== "changed"));
  });
});

test("the agent working for a contact reaches exactly its chat, though it works in the whole space", async () => {
  await setup(async ({ runtime, carla, carlas }) => {
    await runtime.call("chat.send", { thread: carlas, text: "peek around" }, { actor: carla });
    await runtime.idle();
    assertEquals(peeked?.threads, [carlas]);
    assertEquals(peeked?.messages, [carlas]);
    const actor = peeked!.actor!;
    assertEquals([actor.kind, actor.id, (actor.for as Actor).kind], ["agent", "lead", "contact"]);
    // It's told whom it talks with, by name, and offered nothing that keeps what's said here.
    const request = sent.at(-1)!;
    assert(request.instructions?.includes("You're talking with Carla, a customer, writing on "));
    assert(request.instructions?.includes("People here: Carla."));
    assert(!request.instructions?.includes("memory"), request.instructions);
    assertEquals(request.tools?.map((t) => t.name), ["peek"]);
  });
});

test("the space's people reach every contact's chat; taking a contact out cuts it off at once", async () => {
  await setup(async ({ runtime, shop, carla, carlas, danis, read }) => {
    await runtime.call("chat.send", { thread: carlas, text: "hello" }, { actor: carla });
    await runtime.idle();
    const chats = await runtime.query<Thread[]>("thread.recent", { in: shop }, { actor: ana });
    assert([carlas, danis].every((id) => chats.some((t) => t._id === id)));
    // By name, where a page shows who wrote.
    const names = await runtime.query<Record<string, string>>("contact.names", {
      ids: ["contact:c-carla-01", "contact:c-dani-002", "contact:nobody"],
    }, { actor: ana });
    assertEquals(names, { "contact:c-carla-01": "Carla", "contact:c-dani-002": "Dani" });
    // Someone outside the space reads none of it.
    assertEquals(await read("contact", bob), []);
    assertEquals(await runtime.query("thread.recent", { in: shop }, { actor: bob }), []);

    // Watching its chat, then taken out of it: what it sees goes.
    const seen = runtime.observe<Thread[]>("test", "thread", {}, { actor: carla });
    assertEquals(((await seen.ready) as { value: Thread[] }).value.map((t) => t._id), [carlas]);
    await runtime.call("member.remove", {
      space: carlas,
      on: "thread",
      member: carla,
    }, { actor: ana });
    await runtime.idle();
    assertEquals((seen.get() as { value: Thread[] }).value, []);
    seen.close();
    assertEquals(
      await code(runtime.call("chat.send", { thread: carlas, text: "still?" }, { actor: carla })),
      "forbidden",
    );
  });
});

test("who answers in a space is told to a contact there, never its people; elsewhere, nobody", async () => {
  await setup(async ({ runtime, shop, carla }) => {
    assertEquals(await runtime.call("test.roster", { space: shop }, { actor: carla }), {
      agents: ["lead"],
      default: "lead",
    });
    const { space: other } = await runtime.call<{ space: string }>("space.create", {
      name: "Other",
    }, { actor: bob });
    assertEquals(await runtime.call("test.roster", { space: other }, { actor: carla }), {
      agents: [],
    });
  });
});

test("a contact joins documents only, and never manages them", async () => {
  await setup(async ({ runtime, shop, staff, carla }) => {
    assertEquals(
      await code(runtime.call("member.set", { space: shop, member: carla, role: "viewer" }, {
        actor: ana,
      })),
      "invalid",
    );
    assertEquals(
      await code(
        runtime.call("member.set", { space: staff, on: "thread", member: carla, role: "manager" }, {
          actor: ana,
        }),
      ),
      "invalid",
    );
  });
});

test("an Action only people may call refuses a contact", async () => {
  await setup(async ({ runtime, shop, carla, carlas }) => {
    for (
      const [action, input] of [
        ["space.create", { name: "Mine" }],
        ["space.personal", {}],
        ["member.set", { space: carlas, on: "thread", member: carla, role: "viewer" }],
        ["chat.stop", { thread: carlas }],
        ["chat.open", { in: shop }],
      ] as const
    ) {
      assertEquals(await code(runtime.call(action, input, { actor: carla })), "forbidden", action);
    }
    await assertRejects(() =>
      runtime.query("message.history", { thread: carlas }, { actor: carla })
    );
    await assertRejects(() =>
      runtime.query("message.questions", { person: carla.id }, { actor: carla })
    );
  });
});

test("every Action, query and event stays shut to contacts, but those opened to them", () => {
  // Each plugin on its own: some are alternatives to each other (the directory's org Actions).
  const registries = [
    models,
    chat,
    history,
    memory,
    team,
    skills,
    routines,
    tiers,
    ...access,
    googleSignIn,
    accounts,
    directory,
    api,
    terminalPlugin,
    whatsapp,
    computers,
    apps,
    cloud,
    usage,
    stripeWebhook,
    credits,
    stripe,
  ].flat().map((plugin) => merge([plugin], { elsewhere: true }));
  const contact: Actor = { kind: "contact", id: "c-someone" };
  // Asked as they'd ask about themselves: their own id wherever one is named.
  const own = { person: contact.id, agent: contact.id, id: contact.id };
  const open = registries.flatMap((registry) => [
    ...Object.entries(registry.actions).filter(([, def]) => def.allow?.(contact, own))
      .map(([name]) => name),
    ...Object.entries(registry.collections).flatMap(([collection, def]) =>
      Object.entries(def.queries ?? {}).filter(([, query]) =>
        typeof query === "object" && query.allow(contact, own)
      ).map(([name]) => `${collection}.${name}`)
    ),
    ...Object.entries(registry.events).filter(([, def]) => def.allow?.(contact))
      .map(([type]) => type),
  ]).sort();
  // `whatsapp.hook` is Meta's webhook: anyone may call it, and only what Meta signed goes on.
  assertEquals(open, ["chat.send", "whatsapp.hook"]);
});

test("an agent says a fixed message to a contact's chat without a turn, once", async () => {
  await setup(async ({ runtime, carla, carlas }) => {
    await runtime.call("chat.send", { thread: carlas, text: "paid" }, { actor: carla });
    await runtime.idle();
    const calls = sent.length;
    for (let i = 0; i < 2; i++) {
      await runtime.call("chat.say", {
        id: "pix-123:confirmed",
        thread: carlas,
        from: "lead",
        text: "Payment confirmed!",
      });
    }
    await runtime.idle();
    assertEquals(sent.length, calls);
    const history = await runtime.query<Message[]>("message.history", { thread: carlas }, {
      actor: ana,
    });
    const confirmed = history.filter((m) => m.text === "Payment confirmed!");
    assertEquals(confirmed.map((m) => [m._id, m.from, m.to]), [
      ["pix-123:confirmed", "lead", ["contact:c-carla-01"]],
    ]);
    // Whose work it is, from an event's actor: the contact's, through the agent working for them.
    assertEquals(contactOf({ kind: "agent", id: "lead", for: carla }), carla.id);
    assertEquals(contactOf(ana), undefined);
    // Never to an agent: that's a message to send it.
    assertEquals(
      await code(
        runtime.call("chat.say", { id: "x", thread: carlas, from: "lead", text: "x", to: ["ops"] }),
      ),
      "invalid",
    );
  });
});
