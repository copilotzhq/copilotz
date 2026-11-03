/**
 * A model's state (its thinking, signatures) goes back to it: from its tool
 * steps and from its answers, in the turn and in the next ones. It's the
 * agent's: people reading the conversation don't get it, nor do events.
 */
import { assert, assertEquals } from "@std/assert";
import { type Actor, createRuntime, definePlugin } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models, { type LlmAdapter, type LlmMessage } from "../../models/mod.ts";
import { chat, type Message, tool } from "../chat/mod.ts";
import { access } from "../../access/mod.ts";
import { test } from "../../../testing/mod.ts";

const ana: Actor = { kind: "person", id: "ana" };

test("a model's thinking goes back to it from steps and answers, and stays the agent's", async () => {
  /** What each call was sent, and a thought for each: a note first in a turn, then an answer. */
  const sent: LlmMessage[][] = [];
  let n = 0;
  const think: LlmAdapter = {
    async *generate({ messages }) {
      sent.push(messages);
      const call = ++n;
      const opening = messages.at(-1)?.role !== "tool";
      if (opening) {
        yield { type: "tool_call", call: { id: `c${call}`, name: "note", input: {} } };
      } else yield { type: "text", text: `answer ${call}` };
      yield { type: "state", state: { data: [`thought ${call}`] } };
    },
  };
  const created: Record<string, unknown>[] = [];
  const app = definePlugin({
    name: "app",
    resources: {
      provider: { think: { adapter: "think" } },
      agents: {
        lead: { instructions: "Think.", model: "think/lead", default: true, tools: ["note"] },
      },
      tools: { note: tool({ description: "Takes a note.", run: () => "noted" }) },
    },
    adapters: { llm: { think } },
    processors: {
      watch: {
        on: "message.created",
        run: (_ctx, event) => {
          created.push((event.data as { doc: Record<string, unknown> }).doc);
        },
      },
    },
  });
  const runtime = await createRuntime({
    store: memoryStore(),
    plugins: [models, chat, ...access, app],
  });
  try {
    const { space } = await runtime.call<{ space: string }>("space.personal", {}, { actor: ana });
    const { thread } = await runtime.call<{ thread: string }>(
      "chat.send",
      { text: "first", in: space },
      { actor: ana },
    );
    await runtime.idle();
    await runtime.call("chat.send", { thread, text: "second" }, { actor: ana });
    await runtime.idle();

    // Calls 1 and 2 were the first turn (a note, then the answer); 3 opens the second.
    const thoughts = (messages: LlmMessage[]) =>
      messages.flatMap((m) =>
        m.role === "assistant" && m.state ? [(m.state.data as string[])[0]] : []
      );
    assertEquals(thoughts(sent[1]), ["thought 1"], "the step's, while its turn goes on");
    assertEquals(thoughts(sent[2]), ["thought 1", "thought 2"], "and the answer's, next turn");
    const answer = sent[2].findLast((m) => m.role === "assistant")!;
    assertEquals(answer.role === "assistant" && answer.text, "answer 2");

    // People reading it, and events, go without it.
    const read = await runtime.query<Message[]>("message.history", { thread }, { actor: ana });
    assert(read.some((m) => m.from === "lead" && !m.private), "the answer is there");
    assert(read.every((m) => !("state" in m) && !("told" in m)), "no state for people");
    assert(created.length >= 4 && created.every((doc) => !("state" in doc)), "nor in events");
    // Trusted code still has it.
    const kept = await runtime.query<Message[]>("message.history", { thread });
    assertEquals(kept.filter((m) => m.state).length, 4);
  } finally {
    await runtime.close();
  }
});
