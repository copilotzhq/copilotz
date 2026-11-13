/**
 * A contact's chat keeps its staff notes apart (`chat.notes`): a thread of
 * their own in the chat's space, one per chat, made on first use, that the
 * space's people read and the contact never does. Agents there reach all
 * the space does and are told the chat's latest; a reply drafted there goes
 * into the chat as its person's own message. The notes go where the chat
 * goes, and are erased with it. Moving a conversation says first who'll see
 * it and what it drew on (`thread.moving`), in the terminal's words too.
 */
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  type Actor,
  createRuntime,
  defineAction,
  definePlugin,
  type Runtime,
} from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models, { type LlmAdapter, type LlmRequest } from "../../models/mod.ts";
import { chat, type Message, type Moving, notesOf, type Thread } from "../mod.ts";
import { access } from "../../access/mod.ts";
import { test } from "../../../testing/mod.ts";
import { join } from "../../access/tests/join.ts";
import { movingWords } from "../chat/views/terminal/moving.ts";

const ana: Actor = { kind: "person", id: "ana" };
const bob: Actor = { kind: "person", id: "bob" };
const eve: Actor = { kind: "person", id: "eve" };
const carla: Actor = { kind: "contact", id: "c-carla-01" };

/** What the agent was sent, and what its reading tool returned, each call. */
const sent: LlmRequest[] = [];
let chatId = "";

/** Answers; asked to "look", reads the customer's chat first. */
const scripted: LlmAdapter = {
  async *generate(request) {
    sent.push(request);
    const last = request.messages.findLast((m) =>
      !("text" in m && m.text?.startsWith("<context"))
    )!;
    if (last.role === "tool") {
      const read = "text" in last ? last.text ?? "" : JSON.stringify(last);
      return void (yield { type: "text", text: `read: ${read}` });
    }
    const text = "text" in last ? last.text ?? "" : "";
    if (text.includes("look")) {
      return void (yield {
        type: "tool_call",
        call: { id: "r", name: "read_conversation", input: { conversation: chatId } },
      });
    }
    yield { type: "text", text: "noted" };
  },
};

const app = definePlugin({
  name: "app",
  resources: {
    provider: { e: { adapter: "e" } },
    agents: {
      lead: {
        instructions: "Help.",
        model: "e/lead",
        default: true,
        tools: ["read_conversation"],
      },
    },
  },
  adapters: { llm: { e: scripted } },
});

/** Messages as an agent's work wrote them, with its record of what it drew on. */
const seed = definePlugin({
  name: "seed",
  actions: {
    "test.seed": defineAction({
      input: { type: "object" },
      run: (ctx, input: { messages: Record<string, unknown>[] }) =>
        ctx.as().db.collection("message").insertMany(input.messages),
    }),
  },
});

type Setup = {
  runtime: Runtime;
  shop: string;
  launch: string;
  finance: string;
  carlas: string;
};

async function setup(fn: (s: Setup) => Promise<void>) {
  sent.length = 0;
  const runtime = await createRuntime({
    store: memoryStore(),
    plugins: [models, chat, ...access, seed, app],
  });
  try {
    const made = async (name: string, people: Actor[]) => {
      const { space } = await runtime.call<{ space: string }>("space.create", { name }, {
        actor: ana,
      });
      for (const who of people) await join(runtime, space, who, "editor", ana);
      return space;
    };
    const shop = await made("Shop", [bob]);
    const launch = await made("Launch", [bob]);
    const finance = await made("Finance", []);
    await runtime.call("contact.start", { id: carla.id, in: shop, via: "whatsapp", name: "Carla" });
    const { thread: carlas } = await runtime.call<{ thread: string }>("contact.chat", {
      contact: carla.id,
      in: shop,
    });
    chatId = carlas;
    await runtime.call("chat.send", { thread: carlas, text: "where's my order?" }, {
      actor: carla,
    });
    await runtime.idle();
    await fn({ runtime, shop, launch, finance, carlas });
  } finally {
    await runtime.close();
  }
}

/** What `actor` reads of a collection, as a page would. */
const reads = async <T>(runtime: Runtime, collection: string, actor: Actor, filter = {}) => {
  const seen = runtime.observe<T[]>(collection, filter, { actor });
  const output = await seen.ready;
  seen.close();
  return output.status === "ready" ? output.value : [];
};

const probe = definePlugin({
  name: "probe",
  views: Object.fromEntries(
    ["thread", "message"].map((c) => [
      c,
      (
        filter: Record<string, unknown> | undefined,
        ctx: { db: { collection(n: string): { find(f: unknown): { value?: unknown } } } },
      ) => ctx.db.collection(c).find(filter ?? {}).value ?? [],
    ]),
  ),
});

const code = (p: Promise<unknown>) =>
  p.then(() => "done", (e) => (e as { code?: string }).code ?? String(e));

test("a contact's chat keeps its notes apart: one, made on first use, never the contact's", async () => {
  sent.length = 0;
  const runtime = await createRuntime({
    store: memoryStore(),
    plugins: [models, chat, ...access, seed, app, probe],
  });
  try {
    const { space: shop } = await runtime.call<{ space: string }>("space.create", {
      name: "Shop",
    }, { actor: ana });
    await join(runtime, shop, bob, "editor", ana);
    await runtime.call("contact.start", { id: carla.id, in: shop, via: "whatsapp", name: "Carla" });
    const { thread: carlas } = await runtime.call<{ thread: string }>("contact.chat", {
      contact: carla.id,
      in: shop,
    });
    await runtime.call("chat.send", { thread: carlas, text: "hi" }, { actor: carla });
    await runtime.idle();
    // Bob asks first: made, in the chat's space, answered by its agents.
    const opened = await runtime.call<{ thread: string; about: string }>("chat.notes", {
      thread: carlas,
    }, { actor: bob });
    assertEquals(opened, { thread: notesOf(carlas), about: carlas });
    const [notes] = await reads<Thread>(runtime, "thread", ana, { _id: opened.thread });
    // Its title is the chat's, as it is: what they are (`about`) views say around it.
    assertEquals(
      [notes.about, notes.in, notes.title, notes.agents],
      [carlas, shop, "Carla", ["lead"]],
    );
    // Asked again, or about the notes themselves: the same ones.
    for (const thread of [carlas, opened.thread]) {
      assertEquals(
        await runtime.call("chat.notes", { thread }, { actor: ana }),
        opened,
      );
    }
    assertEquals((await reads<Thread>(runtime, "thread", ana, { about: carlas })).length, 1);
    // What's said there, the space's people read; the contact, nothing of it.
    await runtime.call("chat.send", { thread: opened.thread, text: "she's a regular", to: [] }, {
      actor: ana,
    });
    assertEquals(
      (await reads<Message>(runtime, "message", bob, { thread: opened.thread })).map((m) => m.text),
      ["she's a regular"],
    );
    assertEquals(await reads(runtime, "thread", carla, { _id: opened.thread }), []);
    assertEquals(await reads(runtime, "message", carla, { thread: opened.thread }), []);
    assertEquals(
      await code(runtime.call("chat.notes", { thread: carlas }, { actor: carla })),
      "forbidden",
    );
    // Someone who isn't in the space has no chat to ask about.
    assertEquals(
      await code(runtime.call("chat.notes", { thread: carlas }, { actor: eve })),
      "not_found",
    );
    // A chat nobody outside shares has none: everyone who'd see them sees it.
    const { thread: team } = await runtime.call<{ thread: string }>("chat.send", {
      in: shop,
      text: "stock count",
    }, { actor: ana });
    await runtime.idle();
    assertEquals(
      await code(runtime.call("chat.notes", { thread: team }, { actor: ana })),
      "invalid",
    );
  } finally {
    await runtime.close();
  }
});

test("agents in the notes reach the space and are told the chat's latest; a reply goes over as its person's own", async () => {
  await setup(async ({ runtime, carlas }) => {
    const { thread: notes } = await runtime.call<{ thread: string }>("chat.notes", {
      thread: carlas,
    }, { actor: ana });
    await runtime.call("chat.send", { thread: notes, text: "look at her chat" }, { actor: ana });
    await runtime.idle();
    const asked = sent.at(-2)!;
    const told = JSON.stringify(asked.messages);
    assertStringIncludes(told, `These are your team's notes about conversation ${carlas}`);
    assertStringIncludes(told, "where's my order?");
    assertStringIncludes(told, "Carla never sees it.");
    // Its tool reads the chat as any team chat's agent would, and its answer is written here.
    const said = await runtime.query<Message[]>("message.history", { thread: notes }, {
      actor: ana,
    });
    const answer = said.findLast((m) => m.from === "lead" && !m.private);
    assertStringIncludes(answer?.text ?? "", "where's my order?");
    // Ana sends Carla the reply, as her own: no agent answers it, and Carla reads it.
    const before = (await runtime.query<Message[]>("message.history", { thread: carlas }, {
      actor: ana,
    })).length;
    await runtime.call("chat.send", {
      thread: carlas,
      text: "Your order ships Monday.",
      to: [`contact:${carla.id}`],
    }, { actor: ana });
    await runtime.idle();
    const after = await runtime.query<Message[]>("message.history", { thread: carlas }, {
      actor: ana,
    });
    assertEquals(after.length, before + 1);
    assertEquals([after.at(-1)?.from, after.at(-1)?.text], ["ana", "Your order ships Monday."]);
    const hers = await runtime.query<Message[]>("message.history", { thread: carlas }, {
      actor: ana,
    });
    assert(hers.some((m) => m.text === "Your order ships Monday."));
  });
});

test("the notes go where the chat goes, and are erased with it", async () => {
  await setup(async ({ runtime, carlas, launch }) => {
    const { thread: notes } = await runtime.call<{ thread: string }>("chat.notes", {
      thread: carlas,
    }, { actor: ana });
    await runtime.call("chat.send", { thread: notes, text: "vip", to: [] }, { actor: ana });
    // Moved on their own, they'd leave their chat: refused.
    assertEquals(
      await code(runtime.call("chat.move", { thread: notes, to: launch }, { actor: ana })),
      "invalid",
    );
    await runtime.call("chat.move", { thread: carlas, to: launch }, { actor: ana });
    const moved = await runtime.query<Message[]>("message.history", { thread: notes }, {
      actor: ana,
    });
    assertEquals(moved.map((m) => m.in), [launch]);
    await runtime.call("chat.erase", { thread: carlas });
    assertEquals(
      await runtime.query<Message[]>("message.history", { thread: notes }, { actor: ana }),
      [],
    );
  });
});

test("moving says who'll see it there, and what it drew on, as the mover reaches it", async () => {
  await setup(async ({ runtime, launch, finance }) => {
    const { space: mine } = await runtime.call<{ space: string }>("space.personal", {}, {
      actor: ana,
    });
    const { space: bobs } = await runtime.call<{ space: string }>("space.create", {
      name: "Bob's own",
    }, { actor: bob });
    const { thread } = await runtime.call<{ thread: string }>("chat.send", {
      in: mine,
      text: "plan",
    }, { actor: ana });
    await runtime.idle();
    const at = new Date().toISOString();
    await runtime.call("test.seed", {
      messages: [
        { _id: "d1", thread, in: mine, from: "lead", to: ["ana"], text: "a", drew: [finance], at },
        {
          _id: "d2",
          thread,
          in: mine,
          from: "lead",
          to: ["ana"],
          text: "b",
          drew: [finance, launch, bobs],
          at,
        },
      ],
    });
    const moving = await runtime.query<Moving>("thread.moving", { thread, to: launch }, {
      actor: ana,
    });
    assertEquals(
      [moving.to.name, moving.people, moving.drew.map((p) => p.name), moving.elsewhere],
      ["Launch", 2, ["Finance"], 1],
    );
    assertEquals(
      movingWords(moving, "ana"),
      "Everyone in Launch (2) will see this whole conversation. It drew on Finance and another space.",
    );
    // Nowhere it can't go.
    assertEquals(
      await runtime.query("thread.moving", { thread, to: "nowhere" }, { actor: ana }),
      null,
    );
  });
});

test("the terminal says it in words: who'll see it, what it drew on, by name", () => {
  const place = (name: string, kind = "shared", owner?: string) => ({
    _id: name.toLowerCase(),
    name,
    kind,
    ...(owner ? { owner } : {}),
  });
  const to = place("Launch");
  assertEquals(
    movingWords({ to, people: 12, drew: [], elsewhere: 0 }, "ana"),
    "Everyone in Launch (12) will see this whole conversation.",
  );
  assertEquals(
    movingWords({
      to,
      people: 12,
      drew: [place("Squad 1"), place("Finance"), place("Personal", "personal", "ana")],
      elsewhere: 2,
    }, "ana"),
    "Everyone in Launch (12) will see this whole conversation. It drew on Squad 1, Finance, " +
      "your Personal space and 2 other spaces.",
  );
  assertEquals(
    movingWords(
      {
        to: place("Personal", "personal", "ana"),
        people: 1,
        drew: [place("Personal", "personal", "bo")],
        elsewhere: 0,
      },
      "ana",
      { bo: "Bo" },
    ),
    "Only you will see this conversation, in your Personal space. It drew on Bo's Personal space.",
  );
});

test("a chat's notes, as a contact sees nothing of them, nor of what they say", async () => {
  await setup(async ({ runtime, carlas }) => {
    await assertRejects(() => runtime.call("chat.notes", { thread: carlas }, { actor: carla }));
  });
});
