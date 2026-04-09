/**
 * Live smoke test for prompt cache visibility across repeated calls.
 *
 * Usage:
 *   deno run -A --env-file=../../clients/mobizap/.env scripts/cache-smoke.ts
 */
import { chat } from "../connectors/llm/index.ts";
import type { ProviderName } from "../connectors/llm/types.ts";

const env = Deno.env.toObject();
const provider = (Deno.args[0] || "openai") as ProviderName;
const model = Deno.args[1] ||
  (provider === "gemini" ? "gemini-2.5-flash" : "gpt-5-mini");

const repeatedPrefix = Array.from({ length: 450 }, (_, i) =>
  `Instruction ${i + 1}: Keep this exact line as shared cached context.`
).join("\n");

const messages = [
  {
    role: "system" as const,
    content: [
      "You are a concise assistant.",
      "This request intentionally includes a long repeated prefix to test prompt caching.",
      repeatedPrefix,
    ].join("\n\n"),
  },
  {
    role: "user" as const,
    content: "Reply with exactly: ok",
  },
];

const runOnce = async (label: string) => {
  const startedAt = Date.now();
  const response = await chat(
    { messages },
    {
      provider,
      model,
      outputReasoning: false,
      ...(provider === "openai" ? { reasoningEffort: "minimal" as const } : {}),
    },
    env,
  );

  return {
    label,
    latencyMs: Date.now() - startedAt,
    answer: response.answer,
    usage: response.usage ?? null,
  };
};

const first = await runOnce("first");
const second = await runOnce("second");

console.log(JSON.stringify({ first, second }, null, 2));
