/**
 * In front of a contact, an app's own rules may still act on their own. A
 * Processor that hears an agent's reply in a chat shared with a contact, and
 * moves the chat to people when its rules say so, declares a grant (`as`):
 * it acts for nobody, so the gate that keeps a contact from steering an
 * agent's tools beyond what everyone there may do asks nothing of it, and
 * the record says the grant moved it, answering that reply. The agent's own
 * tool calling the same Action through a grant is still refused, and so is a
 * Processor that doesn't declare one: it runs as the agent whose reply it
 * heard, as before. (An agent's turn is a Processor too: exempting every
 * Processor would exempt every tool.)
 */
import { assertEquals } from "@std/assert";
import {
  type Actor,
  createRuntime,
  defineCollection,
  definePlugin,
  type Event,
  grant,
  type ProcessorDef,
  type Runtime,
  type Store,
} from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models, { type LlmAdapter } from "../../models/mod.ts";
import { chat, type Message, tool } from "../../agents/chat/mod.ts";
import { access } from "../mod.ts";
import { test } from "../../../testing/mod.ts";

const ana: Actor = { kind: "person", id: "ana" };
const carla: Actor = { kind: "contact", id: "c-carla-01" };

/** What the agent says when the app's rules hand a chat over to people. */
const HANDOFF = "A person will take it from here.";

/** Hands over when asked to; moves the chat itself with its tool when told to; says what it saw. */
const agent: LlmAdapter = {
  async *generate({ messages }) {
    const last = messages.findLast((m) => !("text" in m && m.text?.startsWith("<context")))!;
    const said = "text" in last ? last.text ?? "" : "";
    if (last.role === "tool") return void (yield { type: "text", text: `tool: ${said}` });
    if (said.endsWith("move it yourself")) {
      return void (yield { type: "tool_call", call: { id: "m", name: "move", input: {} } });
    }
    yield { type: "text", text: said.endsWith("a person, please") ? HANDOFF : "ok" };
  },
};

/** The people-only space chats are handed over to, made by each test's setup. */
let desk = "";

/**
 * The app's rule: an agent's hand-over in a chat moves the chat to the desk.
 * With `as`, as its own grant; without, as the app wrote it before, through a
 * grant taken in its code. What happened is kept in `handoff`.
 */
const handoff = (as?: string): ProcessorDef => ({
  on: "message.created",
  where: { "doc.from": "lead", "doc.text": HANDOFF },
  ...(as ? { as } : {}),
  run: async (ctx, event: Event) => {
    const { thread } = event.data.doc as Message;
    const kept = { thread, actor: ctx.actor };
    try {
      await (as ? ctx : ctx.as(grant("handoff"))).call("chat.move", { thread, to: desk });
      await ctx.db.collection("handoff").insertOne(kept);
    } catch (error) {
      await ctx.db.collection("handoff").insertOne({ ...kept, refused: (error as Error).message });
    }
  },
});

const app = (as?: string) =>
  definePlugin({
    name: "app",
    collections: {
      handoff: defineCollection({ schema: { type: "object", properties: { thread: {} } } }),
    },
    processors: { "handoff.move": handoff(as) },
    resources: {
      provider: { l: { adapter: "l" } },
      agents: { lead: { instructions: "Sell.", model: "l/lead", default: true, tools: ["move"] } },
      tools: {
        // The agent's own way to the same move: a grant its tool takes.
        move: tool({
          description: "Moves this chat to the desk",
          input: { type: "object", properties: {} },
          run: async (_input, ctx) => {
            await ctx.as(grant("handoff")).call("chat.move", { thread: ctx.thread, to: desk });
            return "moved";
          },
        }),
      },
    },
    adapters: { llm: { l: agent } },
  });

type Setup = { rt: Runtime; store: Store; shop: string; carlas: string };

async function setup(as: string | undefined, fn: (s: Setup) => Promise<void>) {
  const store = memoryStore();
  const rt = await createRuntime({ store, plugins: [models, chat, ...access, app(as)] });
  try {
    const made = async (name: string) =>
      (await rt.call<{ space: string }>("space.create", { name }, { actor: ana })).space;
    const shop = await made("Shop");
    desk = await made("Desk");
    await rt.call("contact.start", { id: carla.id, in: shop, via: "whatsapp", name: "Carla" });
    const { thread: carlas } = await rt.call<{ thread: string }>("contact.chat", {
      contact: carla.id,
      in: shop,
    });
    await rt.idle();
    await fn({ rt, store, shop, carlas });
  } finally {
    await rt.close();
  }
}

/** Carla says `text` in her chat; what the agent answered, once all it set going is done. */
async function says(rt: Runtime, thread: string, text: string) {
  await rt.call("chat.send", { thread, text }, { actor: carla });
  await rt.idle();
  const said = await rt.query<Message[]>("message.history", { thread }, { actor: ana });
  return said.findLast((m) => m.from === "lead" && !m.private)!;
}

/** Where a chat is now. */
const spaceOf = async (store: Store, thread: string) =>
  (await store.findOne("thread", { _id: thread }))?.in;

/** What the app's rule did, without ids. */
const handoffs = async (store: Store) =>
  (await store.find("handoff", {})).map(({ _id: _, ...kept }) => kept);

const REFUSED = '"chat.move" goes beyond what everyone in this conversation may see';

test("a Processor with `as` moves a contact's chat to people on its rules, on the record as its grant, answering the reply", async () => {
  await setup("handoff", async ({ rt, store, shop, carlas }) => {
    const reply = await says(rt, carlas, "a person, please");
    assertEquals(reply.text, HANDOFF);
    // It acted as its grant alone, for nobody, where the reply was; and the chat moved.
    const handoffActor = { kind: "system", id: "handoff", in: shop };
    assertEquals(await handoffs(store), [{ thread: carlas, actor: handoffActor }]);
    assertEquals(await spaceOf(store, carlas), desk);
    // On the record: the move, and the rule's own write, are the grant's, answering the reply.
    const log = await store.events(0);
    const heard = log.find((e) => e.type === "message.created" && e.data._id === reply._id)!;
    assertEquals(heard.actor?.kind, "agent");
    const move = log.find((e) => e.type === "action.started" && e.data.action === "chat.move")!;
    assertEquals([move.actor, move.cause], [handoffActor, heard.id]);
    const moved = log.find((e) =>
      e.type === "thread.updated" && e.data._id === carlas &&
      (e.data.changed as string[]).includes("in")
    )!;
    assertEquals([moved.actor, moved.cause], [handoffActor, move.id]);
    const wrote = log.find((e) => e.type === "handoff.created")!;
    assertEquals([wrote.actor, wrote.cause], [handoffActor, heard.id]);
  });
});

test("the agent's own tool calling the same Action through a grant is still refused", async () => {
  await setup("handoff", async ({ rt, store, shop, carlas }) => {
    const tried = await says(rt, carlas, "move it yourself");
    assertEquals(tried.text, `tool: Error: ${REFUSED}`);
    assertEquals(await spaceOf(store, carlas), shop);
    // Nothing of the app's rule ran: the agent didn't hand over.
    assertEquals(await handoffs(store), []);
  });
});

test("a Processor without `as` runs as the agent whose reply it heard, and is refused as before", async () => {
  await setup(undefined, async ({ rt, store, shop, carlas }) => {
    const reply = await says(rt, carlas, "a person, please");
    assertEquals(reply.text, HANDOFF);
    const [kept] = await handoffs(store);
    assertEquals(kept.refused, REFUSED);
    const actor = kept.actor as Actor;
    assertEquals(
      [actor.kind, actor.id, actor.for, actor.thread, actor.in],
      ["agent", "lead", carla, carlas, shop],
    );
    assertEquals(await spaceOf(store, carlas), shop);
  });
});
