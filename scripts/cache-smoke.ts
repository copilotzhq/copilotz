/**
 * Manual append-only OpenAI prompt-cache gate.
 *
 * API-key transport:
 *   OPENAI_API_KEY=<key> deno run -A --env scripts/cache-smoke.ts api
 *
 * ChatGPT transport:
 *   CHATGPT_ACCESS_TOKEN=<token> CHATGPT_ACCOUNT_ID=<id> \
 *     deno run -A --env scripts/cache-smoke.ts chatgpt
 */
import { chat } from "../runtime/llm/index.ts";
import {
  deriveInternalPromptCacheKey,
  withInternalPromptCacheKey,
} from "../runtime/llm/internal-cache-key.ts";
import type {
  ChatMessage,
  ChatResponse,
  ProviderConfig,
} from "../runtime/llm/types.ts";

const env = Deno.env.toObject();
const transport = Deno.args[0] === "chatgpt" ? "chatgpt" : "api";
const model = Deno.args[1] || "gpt-5.6";
const apiKey = transport === "chatgpt"
  ? env.CHATGPT_ACCESS_TOKEN
  : env.OPENAI_API_KEY || env.OPENAI_KEY;
if (!apiKey) {
  throw new Error(
    transport === "chatgpt"
      ? "CHATGPT_ACCESS_TOKEN is required"
      : "OPENAI_API_KEY is required",
  );
}

const stablePrefix = Array.from(
  { length: 420 },
  (_, index) =>
    `Stable instruction ${
      index + 1
    }: preserve this exact prefix and answer each request in one short sentence.`,
).join("\n");
const system =
  `You are a concise cache diagnostic assistant.\n\n${stablePrefix}`;
const cacheKey = await deriveInternalPromptCacheKey(
  "cache-smoke",
  "append-only-thread",
  "diagnostic-agent",
);
const baseConfig: ProviderConfig = withInternalPromptCacheKey({
  provider: "openai",
  model,
  apiKey,
  openaiApi: "responses",
  outputReasoning: false,
  maxTokens: 80,
  ...(transport === "chatgpt"
    ? {
      baseUrl: "https://chatgpt.com/backend-api/codex",
      extraHeaders: {
        ...(env.CHATGPT_ACCOUNT_ID
          ? { "ChatGPT-Account-ID": env.CHATGPT_ACCOUNT_ID }
          : {}),
      },
    }
    : {}),
}, cacheKey);

async function run(messages: ChatMessage[]): Promise<ChatResponse> {
  return await chat({ messages }, baseConfig, env);
}

function turnPrompt(turn: string, expected: string): string {
  const appendPadding = Array.from(
    { length: 48 },
    (_, index) => `append-only-${turn}-context-${index + 1}`,
  ).join(" ");
  return `${turn}: reply with exactly ${expected}.\n\n${appendPadding}`;
}

const turns: Array<{ label: string; response: ChatResponse }> = [];
const messages: ChatMessage[] = [
  { role: "system", content: system },
  { role: "user", content: turnPrompt("Turn one", "ONE") },
];
const first = await run(messages);
turns.push({ label: "turn-1", response: first });
messages.push(
  { role: "assistant", content: first.answer },
  { role: "user", content: turnPrompt("Turn two", "TWO") },
);
const second = await run(messages);
turns.push({ label: "turn-2", response: second });
messages.push(
  { role: "assistant", content: second.answer },
  { role: "user", content: turnPrompt("Turn three", "THREE") },
);
const third = await run(messages);
turns.push({ label: "turn-3", response: third });

const negative = await run([
  { role: "system", content: `MUTATED PREFIX\n\n${system}` },
  ...messages.slice(1),
]);

const report = {
  transport,
  model,
  cacheKey,
  turns: turns.map(({ label, response }) => ({
    label,
    answer: response.answer,
    inputTokens: response.usage?.inputTokens ?? 0,
    cacheReadInputTokens: response.usage?.cacheReadInputTokens ?? 0,
    cacheWriteInputTokens: response.usage?.cacheCreationInputTokens ?? 0,
  })),
  negativeControl: {
    cacheReadInputTokens: negative.usage?.cacheReadInputTokens ?? 0,
    cacheWriteInputTokens: negative.usage?.cacheCreationInputTokens ?? 0,
  },
};
console.log(JSON.stringify(report, null, 2));

const secondCacheRead = second.usage?.cacheReadInputTokens ?? 0;
const thirdCacheRead = third.usage?.cacheReadInputTokens ?? 0;
if (secondCacheRead === 0 || thirdCacheRead === 0) {
  throw new Error(
    "Append-only warm turn reported zero cached tokens; inspect serialized prompt prefixes before publishing.",
  );
}
if (thirdCacheRead <= secondCacheRead) {
  throw new Error(
    `Append-only cache reads did not grow: turn-2=${secondCacheRead}, turn-3=${thirdCacheRead}.`,
  );
}
if ((negative.usage?.cacheReadInputTokens ?? 0) !== 0) {
  throw new Error("Early-prefix mutation unexpectedly reused cached tokens.");
}
for (const { label, response } of turns.slice(1)) {
  const cacheWrite = response.usage?.cacheCreationInputTokens ?? 0;
  const input = response.usage?.inputTokens ?? 0;
  if (cacheWrite > 0 && cacheWrite >= input) {
    throw new Error(
      `${label} reported a full-prompt cache rewrite (${cacheWrite}/${input}).`,
    );
  }
}
