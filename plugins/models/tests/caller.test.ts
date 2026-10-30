/**
 * A provider's own say over its calls: a `headers` function hears whom each
 * call is for (the actor, and Actions to ask: a person's token); its
 * `options` go into every request, under a model's own; its `tags` go on
 * every use, for whoever hears `modelUse`. A `headers` that fails hands the
 * call to the next model.
 */
import { assertEquals } from "@std/assert";
import { type Actor, createRuntime, defineAction, definePlugin } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models, { type Caller, type LlmAdapter, type LlmRequest, type ModelUse } from "../mod.ts";
import { test } from "../../../testing/mod.ts";

test("a provider's headers hear whom a call is for; its options and tags go on every call", async () => {
  const asked: LlmRequest[] = [];
  const heard: Caller[] = [];
  const uses: ModelUse[] = [];
  const echo: LlmAdapter = {
    async *generate(request) {
      asked.push(request);
      const headers = typeof request.connection.headers === "function"
        ? await request.connection.headers({})
        : request.connection.headers;
      yield { type: "text", text: headers?.authorization ?? "none" };
      yield { type: "usage", input: 1, output: 1 };
    },
  };
  const app = definePlugin({
    name: "app",
    adapters: { llm: { echo } },
    actions: {
      "app.key": defineAction({
        input: { type: "object" },
        record: false,
        run: (ctx) => `key for ${(ctx.actor?.for as Actor | undefined)?.id ?? ctx.actor?.id}`,
      }),
      "app.ask": defineAction({
        input: { type: "object" },
        run: (ctx, input: { model: unknown }) =>
          ctx.as({ kind: "agent", id: "lead", for: { kind: "person", id: "ana" } })
            .call("llm.generate", { model: input.model, messages: [{ role: "user", text: "hi" }] }),
      }),
    },
    resources: {
      provider: {
        mine: {
          adapter: "echo",
          options: { store: false, a: 1 },
          tags: { paid: "subscription" },
          headers: async (caller: Caller) => {
            heard.push(caller);
            if (caller.actor?.id !== "lead") throw new Error("Not for anyone");
            return { authorization: await caller.call!<string>("app.key", {}) };
          },
        },
        other: { adapter: "echo" },
      },
      modelUse: { test: { used: (_: unknown, use: ModelUse) => void uses.push(use) } },
    },
  });
  const rt = await createRuntime({ store: memoryStore(), plugins: [models, app] });
  try {
    const answer = await rt.call<{ text: string }>("app.ask", {
      model: { model: "mine/m", options: { a: 2 } },
    });
    assertEquals(answer.text, "key for ana");
    assertEquals(heard[0].actor?.for, { kind: "person", id: "ana" });
    assertEquals(asked[0].options, { store: false, a: 2 });
    assertEquals(uses.map((u) => [u.subject, u.tags]), [["mine/m", { paid: "subscription" }]]);
    // Called for nobody, its headers fail, and the next model answers.
    const fallback = await rt.call<{ text: string }>("llm.generate", {
      model: ["mine/m", "other/m"],
      messages: [{ role: "user", text: "hi" }],
    });
    assertEquals(fallback.text, "none");
    assertEquals(uses.at(-1)?.subject, "other/m");
  } finally {
    await rt.close();
  }
});
