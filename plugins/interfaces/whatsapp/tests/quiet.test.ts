/**
 * A burst on a customer line: people send two or three short messages a few
 * seconds apart. The agent answers once the customer has been quiet for the
 * line's window (4 s), everything since its last answer in one turn and one
 * reply; a message after it gets its own; and a restart in the window still
 * answers, once. Time is the runtime's clock, moved by hand.
 */
import { assert, assertEquals } from "@std/assert";
import { manualClock } from "../../../../runtime/mod.ts";
import type { LlmAdapter, LlmMessage } from "../../../models/mod.ts";
import { test } from "../../../../testing/mod.ts";
import type { Message, Thread } from "../../../agents/chat/mod.ts";
import { ana, type Setup, setup } from "./setup.ts";

const CARLA = "5511911112222";

/** Each model call's messages, in order. */
const calls: LlmMessage[][] = [];
const counting: LlmAdapter = {
  async *generate({ messages }) {
    calls.push(messages);
    yield { type: "text", text: `answer ${calls.length}` };
  },
};

const open = (s: Setup) =>
  s.runtime.call("whatsapp.set", { number: s.number, open: true }, { actor: ana });
const write = (s: Setup, body: string) =>
  s.deliver([{ text: { body } }], { from: CARLA, name: "Carla" });

test("three messages a moment apart get one turn and one reply; one after the window, its own", async () => {
  calls.length = 0;
  const clock = manualClock(Date.now());
  await setup(async (s) => {
    await open(s);
    const later = async (ms: number) => {
      clock.advance(ms);
      await s.runtime.idle();
    };
    await write(s, "oi");
    await later(2_000);
    await write(s, "quero ir a Santos");
    await later(2_000);
    await write(s, "amanhã cedo");
    // Still writing, as far as anyone knows: nothing's answered yet.
    assertEquals([calls.length, s.graph.texts(CARLA)], [0, []]);
    await later(4_500);
    assertEquals(s.graph.texts(CARLA), ["answer 1"]);
    // One turn, reading all three.
    const read = JSON.stringify(calls[0]);
    assert(["oi", "quero ir a Santos", "amanhã cedo"].every((m) => read.includes(m)), read);
    // A message after it: its own turn, once its window passes.
    await write(s, "e a volta?");
    await later(4_500);
    assertEquals(s.graph.texts(CARLA), ["answer 1", "answer 2"]);
  }, { llm: counting, clock });
});

test("a restart in the window still answers, once", async () => {
  calls.length = 0;
  const clock = manualClock(Date.now());
  await setup(async (s) => {
    await open(s);
    await write(s, "oi");
    await write(s, "uma passagem");
    await s.restart();
    clock.advance(4_500);
    await s.runtime.idle();
    assertEquals(s.graph.texts(CARLA), ["answer 1"]);
    assertEquals(calls.length, 1);
  }, { llm: counting, clock });
});

test("each sender's window is their own: a staff member's doesn't take a customer's place", async () => {
  calls.length = 0;
  const clock = manualClock(Date.now());
  await setup(async (s) => {
    await open(s);
    await write(s, "oi");
    const [chat] = await s.runtime.query<Thread[]>("thread.recent", { in: s.launch }, {
      actor: ana,
    });
    await s.runtime.call("chat.send", { thread: chat._id, text: "staff here", quiet: 4_000 }, {
      actor: ana,
    });
    clock.advance(4_500);
    await s.runtime.idle();
    assertEquals(calls.length, 2);
  }, { llm: counting, clock });
});

test("a turn waiting for quiet in a chat that's erased meanwhile never starts", async () => {
  calls.length = 0;
  const clock = manualClock(Date.now());
  await setup(async (s) => {
    await open(s);
    await write(s, "oi");
    const [chat] = await s.runtime.query<Thread[]>("thread.recent", { in: s.launch }, {
      actor: ana,
    });
    const carla = (await s.runtime.query<Message[]>("message.history", { thread: chat._id }, {
      actor: ana,
    })).find((m) => m.from.startsWith("contact:"))!.from.slice("contact:".length);
    await s.runtime.call("contact.forget", { contact: carla, chats: true }, { actor: ana });
    clock.advance(4_500);
    await s.runtime.idle();
    assertEquals([calls.length, s.graph.texts(CARLA)], [0, []]);
  }, { llm: counting, clock });
});
