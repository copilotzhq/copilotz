/**
 * Who an agent's work is shown to bounds it. In a chat shared with a contact,
 * the shop's own agent reads what everyone there reaches (the chat, and what
 * the shop lets its contacts read), never the rest of the shop. A space
 * drawing on another may let its contacts read it (`contacts: "read"`), read
 * only, one level. Writing into a contact's chat from a team chat waits for a
 * person's yes; working in it, its own chat needs none, and the team's is out
 * of reach. In front of a contact, trusted code goes beyond its caller only
 * in an Action a contact could call, or one of the app's own.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type Actor,
  createRuntime,
  defineAction,
  defineCollection,
  definePlugin,
  people,
  peopleOrContacts,
  personOf,
  type Runtime,
  type ViewContext,
} from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models, { type LlmAdapter } from "../../models/mod.ts";
import { chat, type Message, tool } from "../../agents/chat/mod.ts";
import { access } from "../mod.ts";
import { test } from "../../../testing/mod.ts";

const ana: Actor = { kind: "person", id: "ana" };
const carla: Actor = { kind: "contact", id: "c-carla-01" };
const code = (p: Promise<unknown>) =>
  p.then(() => "done", (e) => (e as { code?: string }).code ?? String(e));

/** "peek" looks around; what it saw, it says. */
const looks: LlmAdapter = {
  async *generate({ messages }) {
    const last = messages.findLast((m) => !("text" in m && m.text?.startsWith("<context")))!;
    const said = "text" in last ? last.text ?? "" : "";
    if (last.role === "tool") return void (yield { type: "text", text: `saw ${said}` });
    const peek = /(peek|peek_as)$/.exec(said)?.[1];
    if (peek) {
      return void (yield { type: "tool_call", call: { id: "p", name: peek, input: {} } });
    }
    yield { type: "text", text: "ok" };
  },
};

type Note = { _id: string; in: string; text: string };
const text = { type: "string" } as const;

/** Elevated, it counts every note: as trusted code going beyond whoever called. */
const counting = (allow?: (actor: Actor) => boolean) =>
  defineAction({
    input: { type: "object" },
    ...(allow ? { allow } : {}),
    run: async (ctx) => {
      const counted = await ctx.as().db.collection("note").countDocuments({});
      // What the app's own Action counted, kept where a test finds it.
      if (!allow) await ctx.as().db.collection("tally").insertOne({ counted });
      return counted;
    },
  });

const app = definePlugin({
  name: "app",
  collections: {
    note: defineCollection({
      schema: { type: "object", properties: { in: text, text }, required: ["in", "text"] },
    }),
    tally: defineCollection({ schema: { type: "object" } }),
  },
  actions: {
    "note.add": defineAction({
      input: { type: "object", properties: { in: text, text }, required: ["in", "text"] },
      allow: peopleOrContacts,
      run: (ctx, input) => ctx.db.collection("note").insertOne(input),
    }),
    "note.list": defineAction({
      input: { type: "object" },
      allow: peopleOrContacts,
      run: async (ctx) =>
        (await ctx.db.collection<Note>("note").find({})).map((n) => n.text).sort(),
    }),
    // A message, as the caller writes it, in a chat.
    "test.say": defineAction({
      input: { type: "object", properties: { thread: text, in: text }, required: ["thread", "in"] },
      allow: people,
      run: async (ctx, input) => {
        await ctx.db.collection("message").insertOne({
          _id: crypto.randomUUID(),
          thread: input.thread,
          in: input.in,
          from: "lead",
          to: [],
          text: "from elsewhere",
          at: new Date().toISOString(),
        });
        return 1;
      },
    }),
    "test.count": counting(people),
    "test.countOpen": counting(peopleOrContacts),
    "test.countInner": counting(),
    "test.tallies": defineAction({
      input: { type: "object" },
      run: (ctx) => ctx.db.collection("tally").find({}),
    }),
    // Sets the app's own count going, as its caller's work, a moment from now.
    "test.countLater": defineAction({
      input: { type: "object" },
      allow: people,
      run: (ctx) => ctx.schedule("test.countInner", {}, { at: new Date().toISOString() }),
    }),
  },
  views: {
    // What someone reads of a chat's messages.
    messages: (filter: Record<string, unknown>, ctx: ViewContext) =>
      (ctx.db.collection<Message>("message").find(filter).value ?? []).map((m) => m.text),
  },
  resources: {
    shared: { note: {} },
    provider: { l: { adapter: "l" } },
    agents: {
      lead: { instructions: "Sell.", model: "l/lead", default: true, tools: ["peek", "peek_as"] },
    },
    tools: {
      // The same, as its agent's person (as a routine's tools act): work done for them.
      peek_as: tool({
        description: "Looks at the notes, as the person it works for",
        input: { type: "object", properties: {} },
        run: async (_input, ctx) => {
          const notes = await ctx.as({ kind: "person", id: personOf(ctx.actor)! }).db
            .collection<Note>("note").find({});
          return notes.map((n) => n.text).sort().join(", ");
        },
      }),
      peek: tool({
        description: "Looks at the notes and chats it can read",
        input: { type: "object", properties: {} },
        run: async (_input, ctx) => {
          const notes = await ctx.db.collection<Note>("note").find({});
          const chats = await ctx.db.collection<{ _id: string }>("thread").find({});
          return `${notes.map((n) => n.text).sort().join(", ")}; chats: ${chats.length}`;
        },
      }),
    },
  },
  adapters: { llm: { l: looks } },
});

type Setup = {
  rt: Runtime;
  shop: string;
  /** What the shop lets its contacts read: its catalog. */
  catalog: string;
  /** Ana's chat in the shop, its team's. */
  staff: string;
  /** Carla's chat in the shop, shared with her. */
  carlas: string;
};

async function setup(fn: (s: Setup) => Promise<void>) {
  const rt = await createRuntime({ store: memoryStore(), plugins: [models, chat, ...access, app] });
  try {
    const made = async (name: string) =>
      (await rt.call<{ space: string }>("space.create", { name }, { actor: ana })).space;
    const shop = await made("Shop");
    const catalog = await made("Catalog");
    const supplier = await made("Supplier");
    // The shop draws on its catalog and lets its contacts read it; the catalog, on its supplier.
    await rt.call("member.set", {
      space: catalog,
      member: { kind: "space", id: shop },
      role: "viewer",
      contacts: "read",
    }, { actor: ana });
    await rt.call("member.set", {
      space: supplier,
      member: { kind: "space", id: catalog },
      role: "viewer",
      contacts: "read",
    }, { actor: ana });
    for (
      const [where, said] of [[shop, "margin 12%"], [catalog, "tickets 80"], [supplier, "cost 50"]]
    ) {
      await rt.call("note.add", { in: where, text: said }, { actor: ana });
    }
    const { thread: staff } = await rt.call<{ thread: string }>("chat.open", { in: shop }, {
      actor: ana,
    });
    await rt.call("contact.start", { id: carla.id, in: shop, via: "whatsapp", name: "Carla" });
    const { thread: carlas } = await rt.call<{ thread: string }>("contact.chat", {
      contact: carla.id,
      in: shop,
    });
    await rt.idle();
    await fn({ rt, shop, catalog, staff, carlas });
  } finally {
    await rt.close();
  }
}

/** What the agent said last in `thread`, asked by `actor`. */
async function asked(rt: Runtime, thread: string, actor: Actor, text: string) {
  await rt.call("chat.send", { thread, text }, { actor });
  await rt.idle();
  const said = await rt.query<Message[]>("message.history", { thread }, { actor: ana });
  return said.findLast((m) => m.from === "lead" && !m.private)!;
}

/** What `actor` reads of a chat's messages. */
async function reads(rt: Runtime, thread: string, actor: Actor) {
  const seen = rt.observe<string[]>("messages", { thread }, { actor });
  const output = await seen.ready;
  seen.close();
  return output.status === "ready" ? output.value : [];
}

test("in a contact's chat, the shop's agent reads the chat and what contacts may, never the rest of the shop", async () => {
  await setup(async ({ rt, staff, carlas }) => {
    // In the team's chat, all the shop reaches: its notes, what it draws on, and its chats.
    assertEquals(
      (await asked(rt, staff, ana, "peek")).text,
      "saw cost 50, margin 12%, tickets 80; chats: 2",
    );
    // Ana asking in Carla's chat: what Carla reaches too (her chat, the catalog), and nothing
    // the shop keeps to itself; the catalog's own supplier neither.
    const answer = await asked(rt, carlas, ana, "peek");
    assertEquals(answer.text, "saw tickets 80; chats: 1");
    // Carla reads it, as she reads everything said there.
    assert((await reads(rt, carlas, carla)).includes(answer.text!));
    // Carla asking: the same.
    assertEquals((await asked(rt, carlas, carla, "peek")).text, "saw tickets 80; chats: 1");
  });
});

test("a space drawing on another lets its contacts read it when it says so: read only, one level", async () => {
  await setup(async ({ rt, shop, catalog }) => {
    // Carla reads the catalog, not what it draws on in turn (its supplier), nor the shop's own.
    assertEquals(await rt.call("note.list", {}, { actor: carla }), ["tickets 80"]);
    // Read, never written.
    assertEquals(
      await code(rt.call("note.add", { in: catalog, text: "cheaper?" }, { actor: carla })),
      "forbidden",
    );
    // A draw that doesn't say so lets no contact in.
    await rt.call("member.set", {
      space: catalog,
      member: { kind: "space", id: shop },
      role: "viewer",
    }, { actor: ana });
    assertEquals(await rt.call("note.list", {}, { actor: carla }), []);
  });
});

test("writing into a contact's chat from a team's waits for a yes; in it, nothing to ask", async () => {
  await setup(async ({ rt, shop, staff, carlas }) => {
    const working = (thread: string, more: Record<string, unknown> = {}): Actor => ({
      kind: "agent",
      id: "lead",
      for: ana,
      in: shop,
      thread,
      ...more,
    });
    const say = (actor: Actor, thread: string) =>
      code(rt.call("test.say", { thread, in: shop }, { actor }));
    // From the team's chat, the shop's words would reach Carla.
    assertEquals(await say(working(staff), carlas), "needs_approval");
    // Said yes to (her chat, or the shop itself), it goes, and Carla reads it.
    assertEquals(await say(working(staff, { approved: [`thread:${carlas}`] }), carlas), "done");
    assertEquals(await say(working(staff, { approved: [shop] }), carlas), "done");
    assert((await reads(rt, carlas, carla)).includes("from elsewhere"));
    // Working in Carla's chat, it writes there with nothing to ask; the team's chat is out of
    // its reach altogether.
    assertEquals(await say(working(carlas), carlas), "done");
    assertEquals(await say(working(carlas), staff), "forbidden");
  });
});

test("in front of a contact, trusted code goes beyond its caller only in an Action a contact could call, or the app's own", async () => {
  await setup(async ({ rt, shop, staff, carlas }) => {
    const working = (thread: string): Actor => ({
      kind: "agent",
      id: "lead",
      for: ana,
      in: shop,
      thread,
    });
    const tallied = async () => {
      for (let i = 0; i < 50; i++) {
        const kept = await rt.call<{ counted: number }[]>("test.tallies", {});
        if (kept.length) return kept.map((t) => t.counted);
        await new Promise((resolve) => setTimeout(resolve, 20));
        await rt.idle();
      }
      return [];
    };
    // In Carla's chat: one only people call is refused; one she could call goes.
    await assertRejects(
      () => rt.call("test.count", {}, { actor: working(carlas) }),
      Error,
      '"test.count" goes beyond what everyone in this conversation may see',
    );
    assertEquals(await rt.call("test.countOpen", {}, { actor: working(carlas) }), 3);
    // The app's own (no `allow`), set going from there: goes.
    await rt.call("test.countLater", {}, { actor: working(carlas) });
    assertEquals(await tallied(), [3]);
    // In the team's chat, both go.
    assertEquals(await rt.call("test.count", {}, { actor: working(staff) }), 3);
    assertEquals(await rt.call("test.countOpen", {}, { actor: working(staff) }), 3);
  });
});

test("bug: a tool acting as its agent's person in a contact's chat reads beyond the chat's bound", async () => {
  await setup(async ({ rt, staff, carlas }) => {
    // In the team's chat, as Ana: all the shop reaches.
    assertEquals(
      (await asked(rt, staff, ana, "peek_as")).text,
      "saw cost 50, margin 12%, tickets 80",
    );
    // In Carla's chat, work done as Ana for her agent is bound as the agent's is: what Carla
    // reaches too. (`ctx.as` keeps `in` but not `thread`, so it reaches the whole shop, and the
    // agent says it to Carla.)
    assertEquals((await asked(rt, carlas, ana, "peek_as")).text, "saw tickets 80");
  });
});

test("bug: a write refused for approval doesn't say where to (`to`) to whoever called", async () => {
  await setup(async ({ rt, shop, staff, carlas }) => {
    const refused = await rt.call("test.say", { thread: carlas, in: shop }, {
      actor: { kind: "agent", id: "lead", for: ana, in: shop, thread: staff },
    }).then(() => undefined, (e: { code?: string; to?: string; named?: string }) => e);
    assertEquals(refused?.code, "needs_approval");
    // What a yes would be for, so a turn can ask for it: lost on the way (the wire keeps only
    // `message`, `code`, `final` and `public`).
    assertEquals([refused?.to, refused?.named], [`thread:${carlas}`, "this conversation"]);
  });
});
