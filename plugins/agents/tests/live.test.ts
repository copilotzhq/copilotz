/**
 * What agents write shows as it comes: a turn's live document holds its
 * step's answer so far and its tool calls, and goes in the commit that
 * writes what it became, so an observed View never shows both, or neither.
 */
import { assert, assertEquals } from "@std/assert";
import { createRuntime, definePlugin, type ViewContext } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import { sqliteStore } from "../../../stores/sql/sqlite/mod.ts";
import models, { type LlmAdapter } from "../../models/mod.ts";
import { chat, type Live, type Message, tool } from "../chat/mod.ts";
import { tempFile, test } from "../../../testing/mod.ts";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Looks up the weather, then answers in three pieces, slower than live writes. */
const slow: LlmAdapter = {
  async *generate({ messages }) {
    if (!messages.some((m) => m.role === "tool")) {
      yield { type: "tool_call", call: { id: "c1", name: "weather", input: { city: "Lisbon" } } };
      return;
    }
    for (const piece of ["It is", " sunny", " in Lisbon."]) {
      await pause(120);
      yield { type: "text", text: piece };
    }
  },
};

type Shown = { said: string[]; live: { text: string; calls: string[] }[] };

const app = definePlugin({
  name: "app",
  resources: {
    provider: { slow: { adapter: "slow" } },
    agents: {
      lead: { instructions: "Hi.", model: "slow/lead", tools: ["weather"], default: true },
    },
    tools: {
      weather: tool({
        description: "The weather in a city",
        input: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
        run: async ({ city }) => (await pause(120), `Sunny in ${city}`),
      }),
    },
  },
  adapters: { llm: { slow } },
  views: {
    // A conversation as a screen shows it: what was said, then what's being written.
    watch: {
      test: (item: { thread: string }, ctx: ViewContext): Shown => {
        const said = ctx.db.collection<Message>("message").find({ thread: item.thread }, {
          sort: { at: 1 },
        });
        const live = ctx.db.collection<Live>("live").find({ thread: item.thread });
        return {
          said: (said.value ?? []).map((m) =>
            m.toolCalls ? `${m.from} used ${m.toolCalls.length}` : `${m.from}: ${m.text}`
          ),
          live: (live.value ?? []).map((l) => ({
            text: l.text,
            calls: l.calls.map((c) => `${c.name}${c.output ? ` → ${c.output}` : ""}`),
          })),
        };
      },
    },
  },
});

const stores = { memory: memoryStore, sqlite: () => sqliteStore({ path: tempFile(".sqlite") }) };

for (const [name, make] of Object.entries(stores)) {
  test(`${name}: a reply shows as it's written, then becomes the message in one change`, async () => {
    const runtime = await createRuntime({ store: await make(), plugins: [models, chat, app] });
    try {
      const thread = crypto.randomUUID();
      const watch = runtime.observe<Shown>("test", "watch", { thread });
      await watch.ready;
      const seen: Shown[] = [];
      watch.subscribe(() => {
        const out = watch.get();
        if (out.status === "ready") seen.push(out.value);
      });
      await runtime.call("chat.send", { thread, from: "ana", text: "Weather?" });
      await runtime.idle();
      await pause(20);
      watch.close();

      const last = seen.at(-1)!;
      assertEquals(last, {
        said: ["ana: Weather?", "lead used 1", "lead: It is sunny in Lisbon."],
        live: [],
      });
      // The tool call showed while it ran; then its step, with what it returned.
      assert(seen.some((s) => s.live[0]?.calls[0] === "weather"), JSON.stringify(seen));
      // The answer grew in pieces.
      assert(seen.some((s) => s.live[0]?.text === "It is"));
      assert(seen.some((s) => s.live[0]?.text === "It is sunny"));
      // Never both what was being written and what it became, nor neither.
      for (const s of seen) {
        const step = s.said.includes("lead used 1");
        const reply = s.said.some((line) => line.startsWith("lead: "));
        if (reply) assertEquals(s.live, [], JSON.stringify(s));
        if (s.live[0]?.text) assert(step && !reply, JSON.stringify(s));
      }
    } finally {
      await runtime.close();
    }
  });
}
