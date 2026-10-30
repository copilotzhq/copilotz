/** Chat with spaces: each person reaches their own conversations, and only those. */
import { assertEquals, assertRejects } from "@std/assert";
import { type Actor, createRuntime, definePlugin } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models, { type LlmAdapter } from "../../models/mod.ts";
import { chat, type Message } from "../../agents/chat/mod.ts";
import { access } from "../mod.ts";
import { test } from "../../../testing/mod.ts";

const ana: Actor = { kind: "person", id: "ana" };
const bob: Actor = { kind: "person", id: "bob" };
const hi: LlmAdapter = {
  async *generate() {
    yield { type: "text", text: "hi" };
  },
};

test("a person reads, writes in, forks and stops only the conversations they reach", async () => {
  const app = definePlugin({
    name: "app",
    resources: {
      shared: { thread: {}, message: {} },
      provider: { h: { adapter: "h" } },
      agents: { lead: { instructions: "Hi.", model: "h/lead", default: true } },
    },
    adapters: { llm: { h: hi } },
  });
  const runtime = await createRuntime({
    store: memoryStore(),
    plugins: [models, chat, ...access, app],
  });
  try {
    const { space } = await runtime.call<{ space: string }>("space.personal", {}, { actor: ana });
    const { thread, message } = await runtime.call<{ thread: string; message: string }>(
      "chat.send",
      { text: "my plans", in: space },
      { actor: ana },
    );
    await runtime.idle();
    assertEquals(
      (await runtime.query<Message[]>("message.history", { thread }, { actor: ana })).length,
      2,
    );
    assertEquals(await runtime.query("message.history", { thread }, { actor: bob }), []);
    await assertRejects(
      () => runtime.call("chat.stop", { thread }, { actor: bob }),
      Error,
      "No conversation",
    );
    assertEquals(await runtime.call("chat.stop", { thread }, { actor: ana }), { stopped: 0 });
    await assertRejects(() => runtime.call("chat.fork", { thread, message }, { actor: bob }));
    // Writing into it fails, and writes nothing.
    await assertRejects(() =>
      runtime.call("chat.send", { thread, text: "hello?" }, { actor: bob })
    );
    assertEquals(
      (await runtime.query<Message[]>("message.history", { thread }, { actor: ana })).length,
      2,
    );
  } finally {
    await runtime.close();
  }
});
