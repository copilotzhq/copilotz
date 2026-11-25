/**
 * `llm.test`: one short call on a model the asker's own plan pays for, to
 * show it answers there: a provider tagged `paid: "subscription"`, one model
 * (nothing falls to another), the words fixed. A model the app pays for is
 * refused; a failure keeps its code, for the connect flow to say what to do.
 */
import { assert, assertEquals } from "@std/assert";
import { type Actor, createRuntime, definePlugin } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models, { type LlmAdapter, type LlmRequest } from "../mod.ts";
import { test } from "../../../testing/mod.ts";

const ana: Actor = { kind: "person", id: "ana" };

test("a plan's model answers a short test, as its person; the app's own models, and lists, aren't tried", async () => {
  const asked: LlmRequest[] = [];
  let failing: Error | undefined;
  const plan: LlmAdapter = {
    async *generate(request) {
      asked.push(request);
      if (failing) throw failing;
      yield { type: "text", text: "Ready." };
      yield { type: "usage", input: 1, output: 1 };
    },
  };
  const app = definePlugin({
    name: "app",
    adapters: { llm: { plan } },
    resources: {
      provider: {
        "claude-plan": { adapter: "plan", tags: { paid: "subscription" } },
        anthropic: { adapter: "plan" },
      },
    },
  });
  const rt = await createRuntime({ store: memoryStore(), plugins: [models, app] });
  const attempt = (model: unknown, actor: Actor = ana) =>
    rt.call<{ text: string; ms: number }>("llm.test", { model }, { actor }).catch((error) => ({
      code: (error as { code?: string }).code,
      message: (error as Error).message,
    }));
  try {
    const answer = await attempt("claude-plan/claude-haiku-5-5") as { text: string; ms: number };
    assertEquals(answer.text, "Ready.");
    assert(answer.ms >= 0);
    assertEquals(asked.length, 1);
    assertEquals(asked[0].messages.at(-1), { role: "user", text: "Answer with one word: ready." });

    // The app's own key isn't spent on a test, and a list isn't one model.
    assertEquals((await attempt("anthropic/claude-haiku-5-5") as { code: string }).code, "invalid");
    assertEquals(
      (await attempt(["claude-plan/claude-haiku-5-5", "anthropic/claude-haiku-5-5"]) as {
        code: string;
      }).code,
      "invalid",
    );
    // Only someone, in person.
    const agent: Actor = { kind: "agent", id: "north", for: ana };
    assertEquals(
      (await attempt("claude-plan/claude-haiku-5-5", agent) as { code: string }).code,
      "forbidden",
    );
    assertEquals(asked.length, 1, "none of those were tried");

    // A failure keeps its code: at its limit, the flow says so.
    failing = Object.assign(new Error("You've hit your usage limit"), { code: "engine_limit" });
    assertEquals(await attempt("claude-plan/claude-haiku-5-5"), {
      code: "engine_limit",
      message: "You've hit your usage limit",
    });
  } finally {
    await rt.close();
  }
});
