/**
 * Plans first, native first: a model list given a person's plans
 * (`harnesses`, in their order) runs each model on the plans that serve it
 * first, model by model in the list's order, and on the models' own
 * providers after every plan. A plan that said which models it runs
 * (`served`) runs one by its list: by the API's name, or with the entry's
 * effort; one without a list, by its `serves` map. An entry naming a plan
 * stands for its model, on plans only; a list left empty is tried as
 * written. `models.check` answers what a list would try, in order.
 */
import { assertEquals } from "@std/assert";
import { createRuntime, definePlugin } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models, { type ModelRef, type Provider } from "../mod.ts";
import { loadCatalog, resolve } from "../shared/choice.ts";
import { test } from "../../../testing/mod.ts";

await loadCatalog();

/** A plan of the person's: what it serves, where it goes by default, which plan it is. */
const plan = (
  order: number,
  serves: Record<string, string>,
  name: string,
  catalog: string | false,
): Provider => ({ adapter: "openai", catalog, harness: { order, serves, plan: name } });

const provider: Record<string, Provider> = {
  anthropic: { apiKey: "a" },
  openai: { apiKey: "o" },
  google: { apiKey: "g" },
  xai: { apiKey: "x" },
  "claude-plan": plan(10, { "anthropic/*": "*" }, "Claude", "anthropic"),
  chatgpt: plan(20, { "openai/*": "*" }, "ChatGPT", "openai"),
  "codex-plan": plan(30, { "openai/*": "*" }, "ChatGPT", "openai"),
  "grok-plan": plan(40, { "xai/*": "*" }, "Grok", "xai"),
  // A plan with names of its own for some models, and every one of a provider's by the same.
  "gemini-plan": plan(
    50,
    { "google/*": "*", "anthropic/claude-sonnet-5-5": "sonnet-thinking" },
    "Google AI",
    false,
  ),
  // Every maker's models, by the same names, until it says its list.
  "cursor-plan": plan(
    60,
    { "anthropic/*": "*", "openai/*": "*", "google/*": "*", "xai/*": "*" },
    "Cursor",
    false,
  ),
};
const resources = { provider, model: { deep: { model: "anthropic/claude-opus-5-5" } } };

const OPUS = { model: "anthropic/claude-opus-5-5", effort: "medium", maxTokens: 30_000 };
const SOL = { model: "openai/gpt-6.2-sol", effort: "medium", maxTokens: 30_000 };
const NEON = { model: "google/gemini-4-neon", effort: "high" };
const LUNA = "openai/gpt-6-luna";
const HAIKU = "anthropic/claude-haiku-5-5";

/** What a list tries for someone with these plans: each model, as `"provider/model"`. */
const tried = (ref: ModelRef, harnesses: string[]) =>
  resolve(resources, { model: ref, harnesses }).map((m) => m.id);

test("plans first: each model on the person's plans that serve it, then the APIs", () => {
  const north = [OPUS, SOL];
  assertEquals(tried(north, []), ["anthropic/claude-opus-5-5", "openai/gpt-6.2-sol"]);
  // Someone with only ChatGPT runs on it before Anthropic's API.
  assertEquals(tried(north, ["chatgpt"]), [
    "chatgpt/gpt-6.2-sol",
    "anthropic/claude-opus-5-5",
    "openai/gpt-6.2-sol",
  ]);
  assertEquals(tried(north, ["claude-plan"]), [
    "claude-plan/claude-opus-5-5",
    "anthropic/claude-opus-5-5",
    "openai/gpt-6.2-sol",
  ]);
  // The list's model order wins; the person's order ranks the plans serving one model.
  const all = ["claude-plan", "chatgpt", "codex-plan", "grok-plan"];
  assertEquals(tried(north, all), [
    "claude-plan/claude-opus-5-5",
    "chatgpt/gpt-6.2-sol",
    "codex-plan/gpt-6.2-sol",
    "anthropic/claude-opus-5-5",
    "openai/gpt-6.2-sol",
  ]);
  assertEquals(tried(north, ["codex-plan", "chatgpt", "claude-plan"]), [
    "claude-plan/claude-opus-5-5",
    "codex-plan/gpt-6.2-sol",
    "chatgpt/gpt-6.2-sol",
    "anthropic/claude-opus-5-5",
    "openai/gpt-6.2-sol",
  ]);
  // Grok, last in the list, runs before any API, never before an earlier model's plan.
  assertEquals(tried([OPUS, SOL, "xai/grok-4.7"], all), [
    "claude-plan/claude-opus-5-5",
    "chatgpt/gpt-6.2-sol",
    "codex-plan/gpt-6.2-sol",
    "grok-plan/grok-4.7",
    "anthropic/claude-opus-5-5",
    "openai/gpt-6.2-sol",
    "xai/grok-4.7",
  ]);
  // Everyday's builder: Luna first, on ChatGPT; Haiku next, on Claude.
  assertEquals(tried([LUNA, HAIKU], ["claude-plan", "chatgpt"]), [
    "chatgpt/gpt-6-luna",
    "claude-plan/claude-haiku-5-5",
    "openai/gpt-6-luna",
    "anthropic/claude-haiku-5-5",
  ]);
  // A checker on Gemini: Antigravity serves it by the same name.
  assertEquals(tried([NEON, OPUS], ["gemini-plan"]), [
    "gemini-plan/gemini-4-neon",
    "google/gemini-4-neon",
    "anthropic/claude-opus-5-5",
  ]);
  assertEquals(tried([NEON, OPUS], ["claude-plan"]), [
    "claude-plan/claude-opus-5-5",
    "google/gemini-4-neon",
    "anthropic/claude-opus-5-5",
  ]);
});

test("a plan that said which models it runs: by the API's name, or with the entry's effort", () => {
  // Antigravity's names have the effort in them, and it has no Gemini 4 Neon; Cursor's are the API's.
  const agy = ["gemini-4-hydrogen-high", "gemini-4-hydrogen-low", "claude-opus-4-6-thinking"];
  const cursor = ["gemini-4-neon", "claude-opus-5-5"];
  const harnesses = ["gemini-plan", "cursor-plan"];
  const on = (ref: ModelRef, served: Record<string, string[]>) =>
    resolve(resources, { model: ref, harnesses, served }).map((m) => [m.id, m.catalog]);
  // A plan whose list lacks the model is passed over: the next plan runs it first.
  assertEquals(on([NEON, OPUS], { "gemini-plan": agy, "cursor-plan": cursor }), [
    ["cursor-plan/gemini-4-neon", "google/gemini-4-neon"],
    ["cursor-plan/claude-opus-5-5", "anthropic/claude-opus-5-5"],
    ["google/gemini-4-neon", "google/gemini-4-neon"],
    ["anthropic/claude-opus-5-5", "anthropic/claude-opus-5-5"],
  ]);
  // Its name with the entry's effort: asked by that name, priced as the API's model.
  const hydrogen = (effort: string) => ({ model: "google/gemini-4-hydrogen", effort });
  assertEquals(on(hydrogen("high"), { "gemini-plan": agy, "cursor-plan": cursor }), [
    ["gemini-plan/gemini-4-hydrogen-high", "google/gemini-4-hydrogen"],
    ["google/gemini-4-hydrogen", "google/gemini-4-hydrogen"],
  ]);
  // No list has it at that effort: the API.
  assertEquals(on(hydrogen("medium"), { "gemini-plan": agy, "cursor-plan": cursor }), [
    ["google/gemini-4-hydrogen", "google/gemini-4-hydrogen"],
  ]);
  // A plan without a list runs what its map says, beside one that said its own.
  assertEquals(on(NEON, { "cursor-plan": ["gemini-4-neon-high"] }), [
    ["gemini-plan/gemini-4-neon", "google/gemini-4-neon"],
    ["cursor-plan/gemini-4-neon-high", "google/gemini-4-neon"],
    ["google/gemini-4-neon", "google/gemini-4-neon"],
  ]);
});

test("a plan's entry keeps the model's settings and its catalog entry, under its own name", () => {
  const [onPlan, next] = resolve(resources, {
    model: [OPUS, { model: "anthropic/claude-sonnet-5-5", options: { beta: true } }],
    harnesses: ["claude-plan", "gemini-plan"],
  });
  assertEquals([onPlan.id, onPlan.catalog, onPlan.settings], [
    "claude-plan/claude-opus-5-5",
    "anthropic/claude-opus-5-5",
    { effort: "medium", maxTokens: 30_000 },
  ]);
  // Its own name for the model; the model's catalog entry; another protocol's options left out.
  const sonnet = resolve(resources, {
    model: { model: "anthropic/claude-sonnet-5-5", options: { beta: true } },
    harnesses: ["gemini-plan"],
  });
  assertEquals(sonnet.map((m) => [m.id, m.catalog, m.settings]), [
    ["gemini-plan/sonnet-thinking", "anthropic/claude-sonnet-5-5", {}],
    ["anthropic/claude-sonnet-5-5", "anthropic/claude-sonnet-5-5", { options: { beta: true } }],
  ]);
  assertEquals(next.id, "claude-plan/claude-sonnet-5-5");
  // Aliases and settings around the list are followed as always.
  assertEquals(tried(["deep", { model: SOL, effort: "high" }], ["chatgpt"]), [
    "chatgpt/gpt-6.2-sol",
    "anthropic/claude-opus-5-5",
    "openai/gpt-6.2-sol",
  ]);
});

test("a list that names plans: each stands for its model, on the person's plans only", () => {
  // As rc.65 lists were written, by hand: plans and APIs, vendor by vendor.
  const written = [
    { ...OPUS, model: "claude-plan/claude-opus-5-5" },
    OPUS,
    { ...SOL, model: "chatgpt/gpt-6.2-sol" },
    { ...SOL, model: "codex-plan/gpt-6.2-sol" },
    SOL,
  ];
  assertEquals(tried(written, ["chatgpt"]), [
    "chatgpt/gpt-6.2-sol",
    "anthropic/claude-opus-5-5",
    "openai/gpt-6.2-sol",
  ]);
  assertEquals(tried(written, []), ["anthropic/claude-opus-5-5", "openai/gpt-6.2-sol"]);
  // A model with no API in the list (the app has no key for it) runs on plans only.
  const planOnly = ["claude-plan/claude-opus-5-5", SOL];
  assertEquals(tried(planOnly, ["codex-plan"]), ["codex-plan/gpt-6.2-sol", "openai/gpt-6.2-sol"]);
  assertEquals(tried(planOnly, ["claude-plan"]), [
    "claude-plan/claude-opus-5-5",
    "openai/gpt-6.2-sol",
  ]);
  // Nothing left for them: the list as written, whose plan says what to do.
  assertEquals(tried("claude-plan/claude-opus-5-5", ["chatgpt"]), [
    "claude-plan/claude-opus-5-5",
  ]);
  // A plan serves its own entries, even a model its map doesn't name.
  assertEquals(tried(["gemini-plan/agy-only", NEON], ["gemini-plan"]), [
    "gemini-plan/agy-only",
    "gemini-plan/gemini-4-neon",
    "google/gemini-4-neon",
  ]);
  // One serving several makers' every model (Cursor) stands for its own model: no maker's.
  assertEquals(tried(["cursor-plan/composer-2.5", OPUS], ["claude-plan", "cursor-plan"]), [
    "cursor-plan/composer-2.5",
    "claude-plan/claude-opus-5-5",
    "cursor-plan/claude-opus-5-5",
    "anthropic/claude-opus-5-5",
  ]);
  // A model no plan serves stays on its API; a name that isn't a plan is passed over.
  assertEquals(tried(["google/gemini-4-neon", LUNA], ["claude-plan", "nobody"]), [
    "google/gemini-4-neon",
    "openai/gpt-6-luna",
  ]);
  // Without `harnesses`, a list is what it says, as before.
  assertEquals(resolve(resources, written).map((m) => m.id), [
    "claude-plan/claude-opus-5-5",
    "anthropic/claude-opus-5-5",
    "chatgpt/gpt-6.2-sol",
    "codex-plan/gpt-6.2-sol",
    "openai/gpt-6.2-sol",
  ]);
});

test("models.check answers what a list would try, in order", async () => {
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [models, definePlugin({ name: "app", resources: { provider } })],
  });
  try {
    assertEquals(
      await rt.call("models.check", {
        model: { model: [OPUS, SOL], harnesses: ["chatgpt"] },
        port: "llm",
      }),
      ["chatgpt/gpt-6.2-sol", "anthropic/claude-opus-5-5", "openai/gpt-6.2-sol"],
    );
    // And by the lists of the plans that said theirs.
    assertEquals(
      await rt.call("models.check", {
        model: {
          model: NEON,
          harnesses: ["gemini-plan", "cursor-plan"],
          served: { "gemini-plan": ["gemini-4-hydrogen-high"] },
        },
        port: "llm",
      }),
      ["cursor-plan/gemini-4-neon", "google/gemini-4-neon"],
    );
  } finally {
    await rt.close();
  }
});
