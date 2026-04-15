/**
 * Live smoke test for provider token usage normalization.
 *
 * Usage:
 *   deno run -A --env-file=../../clients/mobizap/.env scripts/usage-smoke.ts minimax
 *   deno run -A --env-file=../../clients/mobizap/.env scripts/usage-smoke.ts openai
 */
import { chat } from "../runtime/llm/index.ts";
import type { ProviderName } from "../runtime/llm/types.ts";

const provider = (Deno.args[0] || "minimax") as ProviderName;
const env = Deno.env.toObject();
const thinkingEnabled = Deno.args.includes("--thinking");

const defaultModels: Partial<Record<ProviderName, string>> = {
  openai: "gpt-5-mini",
  anthropic: "claude-3-haiku-20240307",
  gemini: "gemini-2.5-flash",
  deepseek: "deepseek-chat",
  minimax: "M2-her",
};

const model = Deno.args[1] || defaultModels[provider];
if (!model) {
  console.error(`No default model configured for provider: ${provider}`);
  Deno.exit(1);
}

const response = await chat(
  {
    messages: [{
      role: "user",
      content: "Reply with exactly: ok",
    }],
  },
  {
    provider,
    model,
    outputReasoning: false,
    ...(thinkingEnabled ? { reasoningEffort: "high" as const } : {}),
    ...(thinkingEnabled && provider === "gemini"
      ? {
        geminiThinkingConfig: {
          includeThoughts: true,
        },
      }
      : {}),
  },
  env,
);

console.log(JSON.stringify({
  provider: response.provider,
  model: response.model,
  answer: response.answer,
  tokens: response.tokens,
  usage: response.usage,
}, null, 2));
