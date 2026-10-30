/**
 * Moving a conversation: from Ana's Personal space into a shared space, with
 * everything in it (messages, files, the subthreads agents opened), by
 * someone who may write in both spaces, and not while agents write in it.
 * What came from elsewhere keeps its marks.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type Actor,
  createRuntime,
  defineAction,
  defineCollection,
  definePlugin,
  type Runtime,
} from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models, { type LlmAdapter, type LlmMessage } from "../../models/mod.ts";
import { chat, type Message, tool } from "../../agents/chat/mod.ts";
import { access } from "../mod.ts";
import { join } from "./join.ts";
import { test } from "../../../testing/mod.ts";

const ana: Actor = { kind: "person", id: "ana" };
const bob: Actor = { kind: "person", id: "bob" };

/** What was said last, past what contexts add each turn. */
const lastOf = (messages: LlmMessage[]) =>
  messages.findLast((m) => !("text" in m && m.text?.startsWith("<context")))!;
const textOf = (m: LlmMessage) => "text" in m ? m.text ?? "" : "";

/** Until it's opened, the lead's turns hold on, writing as they go. */
let gate: Promise<void> = Promise.resolve();

/** The lead: "ask" opens a subthread to the helper; "peek" reads Finance; "slow" holds on. */
const lead: LlmAdapter = {
  async *generate({ messages }) {
    const last = lastOf(messages);
    if (last.role === "tool") return yield { type: "text", text: `Saw: ${textOf(last)}` };
    // Its first word, past who said it ("ana: ask", and the file after).
    const said = textOf(last).replace(/^\w+: /, "").split(/\s/)[0];
    if (said === "ask") {
      return yield {
        type: "tool_call",
        call: {
          id: "s",
          name: "send_message",
          input: { to: "helper", text: "look", in: "subthread" },
        },
      };
    }
    if (said === "peek") {
      return yield { type: "tool_call", call: { id: "p", name: "peek", input: {} } };
    }
    if (said === "slow") {
      yield { type: "text", text: "thinking" };
      await gate;
    }
    yield { type: "text", text: "ok" };
  },
};
const helper: LlmAdapter = {
  async *generate() {
    yield { type: "text", text: "found" };
  },
};

const app = definePlugin({
  name: "app",
  collections: {
    note: defineCollection({
      schema: { type: "object", properties: { in: { type: "string" }, text: { type: "string" } } },
    }),
  },
  actions: {
    "note.add": defineAction({
      allow: () => true,
      input: { type: "object", properties: { in: { type: "string" }, text: { type: "string" } } },
      run: (ctx, input) => ctx.db.collection("note").insertOne(input),
    }),
  },
  resources: {
    shared: { thread: {}, message: { labels: true }, file: {}, note: {} },
    provider: { l: { adapter: "l" }, h: { adapter: "h" } },
    agents: {
      lead: {
        instructions: "Lead.",
        model: "l/lead",
        default: true,
        tools: ["send_message", "peek"],
      },
      helper: { instructions: "Help.", model: "h/helper" },
    },
    tools: {
      peek: tool({
        description: "Reads Finance's notes.",
        run: async (_, ctx) =>
          (await ctx.db.collection<{ text: string }>("note").find({ in: "finance" }))
            .map((n) => n.text).join(", "),
      }),
    },
  },
  adapters: { llm: { l: lead, h: helper } },
});

const setup = async (fn: (rt: Runtime, mine: string) => Promise<void>) => {
  const rt = await createRuntime({ store: memoryStore(), plugins: [models, chat, ...access, app] });
  try {
    const { space } = await rt.call<{ space: string }>("space.personal", {}, { actor: ana });
    await rt.call("space.create", { id: "launch", name: "Launch" }, { actor: ana });
    await join(rt, "launch", bob, "viewer", ana);
    // The lead works in new spaces (the app's default); the helper, where Ana adds it.
    for (const where of [space, "launch"]) {
      await rt.call("member.set", {
        space: where,
        member: { kind: "agent", id: "helper" },
        role: "editor",
      }, { actor: ana });
    }
    await fn(rt, space);
  } finally {
    await rt.close();
  }
};

const say = async (rt: Runtime, text: string, where: { in?: string; thread?: string }) => {
  const sent = await rt.call<{ thread: string }>("chat.send", {
    text,
    ...where,
    ...(text === "ask"
      ? { files: [{ name: "plan.txt", type: "text/plain", data: btoa("plan") }] }
      : {}),
  }, { actor: ana });
  await rt.idle();
  return sent.thread;
};
const seen = async (rt: Runtime, actor: Actor, thread: string) =>
  (await rt.query<Message[]>("message.history", { thread }, { actor })).map((m) => m.text);

test("a conversation moves with everything in it: messages, files, subthreads", async () => {
  await setup(async (rt, mine) => {
    const thread = await say(rt, "ask", { in: mine });
    const [asked] = (await rt.query<Message[]>("message.history", { thread }, { actor: ana }))
      .filter((m) => m.subthread);
    assert(asked, "the lead opened a subthread");
    assertEquals(await seen(rt, bob, thread), []);

    assertEquals(await rt.call("chat.move", { thread, to: "launch" }, { actor: ana }), {
      moved: 2,
      to: "launch",
    });
    // Bob, a viewer in Launch, sees it all now: the conversation, its file, the subthread.
    assertEquals(await seen(rt, bob, thread), await seen(rt, ana, thread));
    const [first] = await rt.query<Message[]>("message.history", { thread }, { actor: bob });
    assertEquals(first.files?.map((f) => f.name), ["plan.txt"]);
    assert((await seen(rt, bob, asked.subthread!)).includes("found"));
  });
});

test("only someone who may write in both spaces moves it; agents don't", async () => {
  await setup(async (rt, mine) => {
    const thread = await say(rt, "hello", { in: mine });
    await rt.call("space.create", { id: "marketing", name: "Marketing" }, { actor: bob });
    await join(rt, "marketing", ana, "viewer", bob);
    await assertRejects(
      () => rt.call("chat.move", { thread, to: "launch" }, { actor: bob }),
      Error,
      "No conversation",
    );
    await assertRejects(
      () => rt.call("chat.move", { thread, to: "marketing" }, { actor: ana }),
      Error,
      "out of your reach",
    );
    await assertRejects(
      () =>
        rt.call("chat.move", { thread, to: "launch" }, {
          actor: { kind: "agent", id: "lead", for: ana },
        }),
      Error,
      "may not call",
    );
    // Nothing moved.
    assertEquals(await seen(rt, bob, thread), []);
  });
});

test("what came from elsewhere keeps its marks when the conversation moves", async () => {
  await setup(async (rt, mine) => {
    await rt.call("space.create", { id: "finance", name: "Finance" }, { actor: ana });
    await rt.call("note.add", { in: "finance", text: "budget 10k" }, { actor: ana });
    const thread = await say(rt, "peek", { in: mine });
    await rt.call("chat.move", { thread, to: "launch" }, { actor: ana });
    assert((await seen(rt, ana, thread)).includes("Saw: budget 10k"));
    // Bob sees the conversation, not what came from Finance, until Ana shares it.
    assertEquals(await seen(rt, bob, thread), ["peek"]);
  });
});

test("a conversation doesn't move while an agent is writing in it", async () => {
  await setup(async (rt, mine) => {
    let open = () => {};
    gate = new Promise((resolve) => open = resolve);
    const { thread } = await rt.call<{ thread: string }>("chat.send", { text: "slow", in: mine }, {
      actor: ana,
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await assertRejects(
      () => rt.call("chat.move", { thread, to: "launch" }, { actor: ana }),
      Error,
      "Agents are writing",
    );
    open();
    await rt.idle();
    await rt.call("chat.move", { thread, to: "launch" }, { actor: ana });
    assertEquals(await seen(rt, bob, thread), ["slow", "thinkingok"]);
  });
});
