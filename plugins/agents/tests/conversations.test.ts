/**
 * Conversations, for agents (chat's `list_conversations` and
 * `read_conversation`): an agent lists the other conversations of the space
 * it works in and reads one, as its person may, people by their profiles'
 * names, without agents' private steps. From a shared space, another space's
 * conversations stay out; from the person's Personal space, which reaches
 * every space they do, another space's are listed with `in` and read by id.
 */
import { assertMatch, assertNotMatch } from "@std/assert";
import { type Actor, createRuntime, definePlugin } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models, { type LlmAdapter, type LlmMessage } from "../../models/mod.ts";
import { chat } from "../chat/mod.ts";
import { access } from "../../access/mod.ts";
import { test } from "../../../testing/mod.ts";

const ana: Actor = { kind: "person", id: "ana" };
const text = (m: LlmMessage) => "text" in m ? m.text ?? "" : "";

/** What the tools answered, in order. */
let outputs: string[] = [];

/** "list [in]" calls list_conversations, "read <id>" read_conversation; then it says "done". */
const script: LlmAdapter = {
  async *generate({ messages }) {
    const last = messages.at(-1)!;
    if (last.role === "tool") {
      outputs.push(text(last));
      yield { type: "text", text: "done" };
      return;
    }
    const said = text(messages.filter((m) => !text(m).startsWith("<context")).at(-1)!);
    const list = said.match(/list(?: (\S+))?$/);
    const read = said.match(/read (\S+)$/);
    const call = list
      ? { name: "list_conversations", input: list[1] ? { in: list[1] } : {} }
      : read
      ? { name: "read_conversation", input: { conversation: read[1] } }
      : undefined;
    if (call) yield { type: "tool_call", call: { id: crypto.randomUUID(), ...call } };
    else yield { type: "text", text: `heard: ${said.slice(-40)}` };
  },
};

test("an agent lists and reads conversations: its space's from anywhere, others' from Personal", async () => {
  outputs = [];
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [
      models,
      chat,
      ...access,
      definePlugin({
        name: "app",
        resources: {
          shared: { thread: {}, message: { drew: true } },
          provider: { s: { adapter: "s" } },
          agents: {
            lead: {
              instructions: "I lead.",
              model: "s/one",
              default: true,
              tools: ["list_conversations", "read_conversation"],
            },
          },
        },
        adapters: { llm: { s: script } },
      }),
    ],
  });
  try {
    const { space: launch } = await rt.call<{ space: string }>("space.create", {
      name: "Launch",
    }, { actor: ana });
    const { space: personal } = await rt.call<{ space: string }>("space.personal", {}, {
      actor: ana,
    });
    // Ana's profile says her name: transcripts say it, not her id.
    await rt.call("person.set", { person: "ana", email: "ana@example.com", name: "Ana Lima" });
    await rt.idle();
    const say = async (space: string, said: string, thread?: string) => {
      const sent = await rt.call<{ thread: string }>(
        "chat.send",
        thread ? { thread, text: said } : { in: space, text: said },
        { actor: ana },
      );
      await rt.idle();
      return sent.thread;
    };
    const pricing = await say(launch, "Pricing: we settled on 12 a month");
    const secret = await say(personal, "My private plans for the weekend");
    const here = await say(launch, "list");

    const [listed] = outputs.splice(0);
    assertMatch(listed, new RegExp(pricing));
    assertMatch(listed, /Pricing: we settled on 12 a month/);
    assertNotMatch(listed, new RegExp(secret), "another space's conversation is listed");
    assertNotMatch(listed, new RegExp(here), "its own conversation is listed");

    await say(launch, `read ${pricing}`, here);
    const [read] = outputs.splice(0);
    assertMatch(read, /\] Ana Lima → lead: Pricing: we settled on 12 a month/);
    assertMatch(read, /lead → Ana Lima: heard/);
    // The tool call this agent made there was a private step: never shown.
    assertNotMatch(read, /list_conversations/);

    // From Launch, shared or not, Ana's Personal space stays out.
    await say(launch, `read ${secret}`, here);
    assertMatch(outputs.splice(0)[0], /No conversation .* that you can read/);
    await say(launch, `list ${personal}`, here);
    assertMatch(outputs.splice(0)[0], /You can't read the space/);

    // In her Personal space her agents reach all she does: its own without `in`, Launch's with it,
    // and one of Launch's by its id.
    const mine = await say(personal, "list");
    const [own] = outputs.splice(0);
    assertMatch(own, new RegExp(secret));
    assertNotMatch(own, new RegExp(pricing), "another space's, unasked");
    await say(personal, `list ${launch}`, mine);
    assertMatch(outputs.splice(0)[0], new RegExp(pricing));
    await say(personal, `read ${pricing}`, mine);
    const [there] = outputs.splice(0);
    assertMatch(there, new RegExp(`Conversation ${pricing} \\(in space ${launch}\\)`));
    assertMatch(there, /Pricing: we settled on 12 a month/);
  } finally {
    await rt.close();
  }
});
