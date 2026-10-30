/**
 * Stopping agents (`chat.stop`): a turn being written stops where it is and
 * answers with what it had written; a turn waiting on a reply stops
 * waiting; neither starts anything new, and nothing they were writing stays.
 */
import { assert, assertEquals } from "@std/assert";
import { createRuntime, definePlugin, type ViewContext } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import { sqliteStore } from "../../../stores/sql/sqlite/mod.ts";
import models, { type LlmAdapter } from "../../models/mod.ts";
import { chat, type Live, type Message } from "../chat/mod.ts";
import { tempFile, test } from "../../../testing/mod.ts";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** "slow" writes slowly; "asker" asks the person who wrote, and waits. */
const model: LlmAdapter = {
  async *generate({ connection, signal }) {
    if (connection.model === "asker") {
      yield {
        type: "tool_call",
        call: { id: "q", name: "send_message", input: { to: "ana", text: "Which city?" } },
      };
      return;
    }
    for (const piece of ["It is", " sunny", " in", " Lisbon."]) {
      await pause(150);
      if (signal?.aborted) return;
      yield { type: "text", text: piece };
    }
  },
};

const app = definePlugin({
  name: "app",
  resources: {
    provider: { m: { adapter: "m" } },
    agents: {
      slow: { instructions: "Hi.", model: "m/slow", default: true },
      asker: { instructions: "Hi.", model: "m/asker", tools: ["send_message"] },
    },
  },
  adapters: { llm: { m: model } },
  views: {
    writing: {
      test: (item: { thread: string }, ctx: ViewContext) =>
        (ctx.db.collection<Live>("live").find({ thread: item.thread }).value ?? []).map((l) =>
          l.text
        ),
    },
  },
});

const stores = { memory: memoryStore, sqlite: () => sqliteStore({ path: tempFile(".sqlite") }) };

for (const [name, make] of Object.entries(stores)) {
  test(`${name}: a turn stopped mid-answer keeps what it had written`, async () => {
    const runtime = await createRuntime({ store: await make(), plugins: [models, chat, app] });
    try {
      const thread = crypto.randomUUID();
      const writing = runtime.observe<string[]>("test", "writing", { thread });
      const started = new Promise<void>((resolve) =>
        writing.subscribe(() => {
          const out = writing.get();
          if (out.status === "ready" && out.value[0]?.startsWith("It is")) resolve();
        })
      );
      await runtime.call("chat.send", { thread, from: "ana", text: "Weather?" });
      await started;
      assertEquals(await runtime.call("chat.stop", { thread }), { stopped: 1 });
      await runtime.idle();

      const said = await runtime.query<Message[]>("message.history", { thread });
      assertEquals(said.map((m) => [m.from, m.text]), [["ana", "Weather?"], [
        "slow",
        said[1].text,
      ]]);
      assert(/^It is( sunny)? \(stopped\)$/.test(said[1].text!), said[1].text);
      assertEquals(said[1].stopped, true);
      // Nothing being written stays, and nothing started again.
      assertEquals(writing.get(), { status: "ready", value: [] });
      await pause(400);
      assertEquals((await runtime.query<Message[]>("message.history", { thread })).length, 2);
      assertEquals(await runtime.call("chat.stop", { thread }), { stopped: 0 });
      writing.close();
    } finally {
      await runtime.close();
    }
  });

  test(`${name}: a turn waiting on a reply stops waiting`, async () => {
    const runtime = await createRuntime({ store: await make(), plugins: [models, chat, app] });
    try {
      const { thread } = await runtime.call<{ thread: string }>("chat.send", {
        from: "ana",
        to: ["asker"],
        text: "Plan a trip",
      });
      await runtime.idle();
      const asked = (await runtime.query<Message[]>("message.questions", { person: "ana" }))[0];
      assertEquals(asked.text, "Which city?");

      assertEquals(await runtime.call("chat.stop", { thread }), { stopped: 1 });
      await runtime.idle();
      const said = await runtime.query<Message[]>("message.history", { thread });
      const answer = said.at(-1)!;
      assertEquals([answer.from, answer.to, answer.text, answer.stopped], [
        "asker",
        ["ana"],
        "(stopped)",
        true,
      ]);
      // Its question is no longer waited on. Answering it anyway is new work:
      // a new turn, not the stopped one resuming.
      assertEquals(await runtime.query("message.questions", { person: "ana" }), []);
      const { message } = await runtime.call<{ message: string }>("chat.send", {
        thread,
        from: "ana",
        text: "Lisbon",
        replyTo: asked._id,
      });
      await runtime.idle();
      const after = (await runtime.query<Message[]>("message.history", { thread }))
        .slice(said.length);
      assertEquals(after.map((m) => m.from), ["ana", "asker", "asker"]);
      assert(after[1].turn && after[1].turn !== answer.turn);
      assertEquals(after[1].turn, `${message}:asker`);
    } finally {
      await runtime.close();
    }
  });
}
