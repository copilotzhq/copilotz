/**
 * A shop, for the tests of archiving chats: Ana made it, Bob writes there, Eve
 * only reads; Carla is a contact with a chat of her own there. Its agents run
 * a script: each one's next move is a function of the message it last saw,
 * and a call may wait (`hold`) until the test lets it go on, so a test can do
 * something while an agent is at work.
 *
 * Lead's moves, by what it was last told:
 * - `list`: lists the space's conversations (`list_conversations`);
 * - `read <id>`: reads one (`read_conversation`);
 * - `sub <words>`: asks Scout in a subthread, and waits for the answer;
 * - `deep <words>`: asks Scout in a subthread, who asks Deep in one of its own;
 * - `ask ana`: asks Ana, in the chat, and waits for her answer;
 * - `tell <thread>`: tells Scout in another chat that's there already;
 * - `hand <space>: <words>`: hands the work to who answers in another space;
 * - `note`: takes a note (a private step), then answers;
 * - `check`: runs a tool that asks Ana first, and goes on with her answer;
 * - after a tool's answer, "lead done"; anything else, "lead heard: <it>".
 */
import {
  type Actor,
  createRuntime,
  defineAction,
  definePlugin,
  type Event,
  type Runtime,
  type Store,
} from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models, { type LlmAdapter, type LlmMessage } from "../../models/mod.ts";
import { chat, type Message, type Thread, tool } from "../chat/mod.ts";
import { access } from "../../access/mod.ts";
import { join } from "../../access/tests/join.ts";

export const ana: Actor = { kind: "person", id: "ana" };
export const bob: Actor = { kind: "person", id: "bob" };
export const eve: Actor = { kind: "person", id: "eve" };
export const carla: Actor = { kind: "contact", id: "c-carla-01" };

export const text = (m: LlmMessage) => "text" in m ? m.text ?? "" : "";

type Move =
  | string
  | {
    send?: Record<string, unknown>[];
    use?: { name: string; input?: Record<string, unknown> }[];
  };

/** What the last message an agent saw said, past who said it ("ana → lead: x" is "x"). */
const words = (m: LlmMessage) => text(m).replace(/^[^:]*: /, "");

const moves: Record<string, (last: LlmMessage) => Move> = {
  lead: (last) => {
    if (last.role === "tool") return "lead done";
    const said = words(last);
    const [verb, ...rest] = said.split(" ");
    const arg = rest.join(" ");
    if (said === "list") return { use: [{ name: "list_conversations" }] };
    if (verb === "read") {
      return { use: [{ name: "read_conversation", input: { conversation: arg } }] };
    }
    if (verb === "sub") return { send: [{ to: "scout", text: arg, in: "subthread" }] };
    if (verb === "deep") return { send: [{ to: "scout", text: `deeper ${arg}`, in: "subthread" }] };
    if (said === "ask ana") return { send: [{ to: "ana", text: "Which one?" }] };
    if (verb === "tell") {
      return { send: [{ to: "scout", text: "For you.", thread: arg, expectReply: false }] };
    }
    const hand = said.match(/^hand (\S+): (.+)$/s);
    if (hand) return { send: [{ space: hand[1], text: hand[2] }] };
    if (said === "note") return { use: [{ name: "note" }] };
    if (said === "check") return { use: [{ name: "check" }] };
    return `lead heard: ${said}`;
  },
  scout: (last) => {
    const said = words(last);
    if (said.startsWith("deeper")) {
      return { send: [{ to: "deep", text: "Go deeper.", in: "subthread" }] };
    }
    return last.role === "tool" ? "scout done" : `scout heard: ${said}`;
  },
  deep: (last) => `deep heard: ${words(last)}`,
};

/** Who's at work right now, and what each waits for before it answers. */
export type Holds = Record<string, Promise<unknown> | undefined>;

/** A gate a test opens: what an agent's call waits for. */
export function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => open = resolve);
  return { opened, open };
}

/** Every tool's answer, in order, as the agent read it. */
export type Kit = {
  runtime: Runtime;
  shop: string;
  /** Ana's Personal space. */
  personal: string;
  /** Carla's chat in the shop, shared with her alone. */
  carlas: string;
  holds: Holds;
  outputs: string[];
  /** Every event committed since the runtime started. */
  events: Event[];
  /** A message, as someone, waiting for what follows; the conversation's id. */
  send(input: Record<string, unknown>, actor?: Actor): Promise<string>;
  /** Threads as the system keeps them (`archived` and all). */
  thread(id: string): Promise<Thread | null>;
  /** What `thread.recent` answers someone. */
  recent(actor: Actor, params?: Record<string, unknown>): Promise<(Thread & Listed)[]>;
  /** A conversation's messages, as the system keeps them. */
  messages(thread: string): Promise<Message[]>;
};

type Listed = { messages: number; first?: string; last?: string };

export async function archiveKit(
  fn: (k: Kit) => Promise<void>,
  options: { store?: () => Store | Promise<Store> } = {},
) {
  const holds: Holds = {};
  const outputs: string[] = [];
  const script: LlmAdapter = {
    async *generate({ connection, messages }) {
      const agent = connection.model;
      await holds[agent];
      const seen = messages.filter((m) => !text(m).startsWith("<context"));
      const last = seen.at(-1)!;
      if (last.role === "tool") outputs.push(text(last));
      const move = moves[agent](last);
      if (typeof move === "string") return void (yield { type: "text", text: move });
      for (const input of move.send ?? []) {
        yield { type: "tool_call", call: { id: crypto.randomUUID(), name: "send_message", input } };
      }
      for (const use of move.use ?? []) {
        yield {
          type: "tool_call",
          call: { id: crypto.randomUUID(), name: use.name, input: use.input ?? {} },
        };
      }
    },
  };
  const app = definePlugin({
    name: "app",
    resources: {
      provider: { s: { adapter: "s" } },
      agents: {
        lead: {
          instructions: "Lead.",
          model: "s/lead",
          default: true,
          tools: ["send_message", "list_conversations", "read_conversation", "note", "check"],
        },
        scout: { instructions: "Scout.", model: "s/scout", tools: ["send_message"] },
        deep: { instructions: "Deep.", model: "s/deep" },
      },
      tools: {
        note: tool({ description: "Takes a note.", run: () => "noted" }),
        check: tool({
          description: "Checks with Ana first.",
          run: (_, ctx) => {
            if (ctx.answer) return `ana said ${ctx.answer.text}`;
            ctx.ask?.({ to: "ana", text: "Sure?" });
            return "asked";
          },
        }),
      },
    },
    adapters: { llm: { s: script } },
    actions: {
      // Threads and messages as they're kept, for the tests to look at (the system's).
      "test.thread": defineAction({
        input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        run: (ctx, input) => ctx.as().db.collection<Thread>("thread").findOne({ _id: input.id }),
      }),
      "test.messages": defineAction({
        input: { type: "object", properties: { thread: { type: "string" } } },
        run: (ctx, input: { thread: string }) =>
          ctx.as().db.collection<Message>("message").find({ thread: input.thread }, {
            sort: { at: 1 },
          }),
      }),
    },
  });
  const runtime = await createRuntime({
    store: await (options.store ?? memoryStore)(),
    plugins: [models, chat, ...access, app],
  });
  const events: Event[] = [];
  const stop = runtime.subscribe((item) => {
    if (item.kind === "event") events.push(item.event);
  });
  try {
    const { space: personal } = await runtime.call<{ space: string }>("space.personal", {}, {
      actor: ana,
    });
    const { space: shop } = await runtime.call<{ space: string }>("space.create", {
      name: "Shop",
    }, { actor: ana });
    await join(runtime, shop, bob, "editor", ana);
    await join(runtime, shop, eve, "viewer", ana);
    // Scout and Deep answer in the shop too (Lead answers new chats everywhere).
    for (const agent of ["scout", "deep"]) {
      await runtime.call("member.set", {
        space: shop,
        member: { kind: "agent", id: agent },
        role: "editor",
      }, { actor: ana });
    }
    await runtime.call("contact.start", { id: carla.id, in: shop, via: "whatsapp", name: "Carla" });
    const { thread: carlas } = await runtime.call<{ thread: string }>("contact.chat", {
      contact: carla.id,
      in: shop,
    });
    await runtime.idle();
    await fn({
      runtime,
      shop,
      personal,
      carlas,
      holds,
      outputs,
      events,
      send: async (input, actor = ana) => {
        const { thread } = await runtime.call<{ thread: string }>("chat.send", input, { actor });
        await runtime.idle();
        return thread;
      },
      thread: (id) => runtime.call<Thread | null>("test.thread", { id }),
      recent: (actor, params = {}) => runtime.query("thread.recent", params, { actor }),
      messages: (thread) => runtime.call<Message[]>("test.messages", { thread }),
    });
  } finally {
    stop();
    await runtime.close();
  }
}

/** Waits until `ready` says so (an agent's step committed), or fails after a while. */
export async function until(ready: () => Promise<boolean>, what: string) {
  for (let tries = 0; tries < 200; tries++) {
    if (await ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Never happened: ${what}`);
}
