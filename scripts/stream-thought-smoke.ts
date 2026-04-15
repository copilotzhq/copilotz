/**
 * Live smoke test: stream one short completion and print [R]/[A] prefixes for reasoning vs answer.
 *
 * Usage (from lib/copilotz):
 *   deno run -A --env-file=.env scripts/stream-thought-smoke.ts openai
 *   deno run -A --env-file=.env scripts/stream-thought-smoke.ts gemini
 *   deno run -A --env-file=.env scripts/stream-thought-smoke.ts minimax
 *
 * Env: OPENAI_API_KEY, GEMINI_API_KEY, MINIMAX_API_KEY (or MINIMAX per chat() merge — use *_API_KEY).
 * Optional: OPENAI_THOUGHT_MODEL (default gpt-5-mini), GEMINI_THOUGHT_MODEL (default gemini-2.5-flash).
 */
import { chat } from "../runtime/llm/index.ts";
import type { ProviderName } from "../runtime/llm/types.ts";

const provider = (Deno.args[0] || "openai") as ProviderName;
const env = Deno.env.toObject();

const models: Record<string, string> = {
  openai: env.OPENAI_THOUGHT_MODEL || "gpt-5-mini",
  gemini: env.GEMINI_THOUGHT_MODEL || "gemini-2.5-flash",
  minimax: env.MINIMAX_THOUGHT_MODEL || "M2-her",
};

const model = models[provider];
if (!model) {
  console.error(`Unknown provider ${provider}; try openai, gemini, minimax`);
  Deno.exit(1);
}

let lastWasReasoning: boolean | undefined;
const enc = new TextEncoder();
const write = (s: string) => Deno.stdout.write(enc.encode(s));

await chat(
  {
    messages: [{
      role: "user",
      content:
        "Reply with one short sentence. If you reason internally, keep the final answer brief.",
    }],
  },
  { provider, model },
  env,
  (token, opts) => {
    const r = Boolean(opts?.isReasoning);
    if (r !== lastWasReasoning) {
      write(r ? "\n[R] " : "\n[A] ");
      lastWasReasoning = r;
    } else if (lastWasReasoning === undefined) {
      write(r ? "[R] " : "[A] ");
      lastWasReasoning = r;
    }
    write(token);
  },
);

console.log("\n--- done ---");
