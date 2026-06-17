/**
 * Gemini Cache Probe (multi-turn)
 * ===============================
 *
 * Investigates intermittent missing cache usage on Gemini multi-turn runs.
 *
 * It runs several turns in the SAME thread with a large, stable system prompt
 * (well above Gemini's implicit-cache minimum), so turns 2+ should hit the
 * implicit cache. For each turn it prints the reported `cacheReadInputTokens`
 * and `status`, and (with COPILOTZ_DEBUG_CACHE=1) the per-SSE-event
 * `[cache-debug] gemini usageMetadata` lines.
 *
 * Goal: determine whether `cachedContentTokenCount` appears in EARLY stream
 * events (cumulative -> a missing value means a genuine cache miss) or only in
 * the FINAL event (timing-sensitive -> a locally-stopped/early-cut turn would
 * lose it and depend on the racy background finalize).
 *
 * Run with:
 *   COPILOTZ_DEBUG_CACHE=1 GEMINI_KEY=<key> \
 *     deno run -A --env examples/gemini-cache-probe.ts
 */
import process from "node:process";
import { createCopilotz } from "../index.ts";
import type { TokenUsage } from "../runtime/llm/types.ts";

const API_KEY = Deno.env.get("GEMINI_KEY") || Deno.env.get("GEMINI_API_KEY") ||
  Deno.env.get("LLM_API_KEY") || Deno.env.get("API_KEY");
if (!API_KEY) {
  console.error(
    "❌  GEMINI_KEY is not set.\n   Run with: COPILOTZ_DEBUG_CACHE=1 GEMINI_KEY=<key> deno run -A --env examples/gemini-cache-probe.ts",
  );
  Deno.exit(1);
}

const MODEL = Deno.env.get("PROBE_MODEL") || "gemini-3.5-flash";

// A large, stable system prompt so the cacheable prefix comfortably exceeds
// Gemini's implicit-cache minimum token threshold.
const STABLE_FILLER = Array.from(
  { length: 600 },
  (_, i) =>
    `Reference clause ${i}: This is stable, unchanging background context that ` +
    `must remain byte-identical across every turn so the provider can reuse a ` +
    `cached prefix. Do not summarize or restate this content to the user.`,
).join("\n");

const copilotz = await createCopilotz({
  namespace: "examples",
  agents: [
    {
      id: "cacheprobe",
      name: "CacheProbe",
      role: "assistant",
      instructions:
        `You are a terse assistant. Answer in one short sentence.\n\n` +
        `=== STABLE REFERENCE LIBRARY (do not repeat) ===\n${STABLE_FILLER}`,
      llmOptions: {
        provider: "gemini",
        model: MODEL,
        reasoningEffort: "low",
        maxTokens: 200,
        apiKey: API_KEY,
      },
    },
  ],
  dbConfig: { url: ":memory:" },
});

const threadExternalId = `cache-probe-${crypto.randomUUID()}`;
const prompts = [
  "Say hello.",
  "Name one color.",
  "Name one animal.",
  "Name one fruit.",
];

console.log(`\n=== Gemini cache probe (model: ${MODEL}) ===`);
console.log(
  "Tip: run with COPILOTZ_DEBUG_CACHE=1 to see per-event [cache-debug] lines.\n",
);

const summary: Array<Record<string, unknown>> = [];

for (let turn = 0; turn < prompts.length; turn++) {
  console.log(`\n--- Turn ${turn + 1}: "${prompts[turn]}" ---`);
  const result = await copilotz.run({
    content: prompts[turn],
    sender: { type: "user", name: "User", id: "probe-user" },
    target: "cacheprobe",
    thread: { externalId: threadExternalId },
  }, { stream: false });

  for await (const event of result.events) {
    if (event.type === "LLM_RESULT") {
      const payload = event.payload as {
        status?: string;
        finishReason?: string;
        usage?: TokenUsage;
      };
      const usage = payload.usage;
      const row = {
        turn: turn + 1,
        status: payload.status,
        finishReason: payload.finishReason,
        inputTokens: usage?.inputTokens ?? null,
        cacheReadInputTokens: usage?.cacheReadInputTokens ?? null,
        usageSource: usage?.source ?? null,
      };
      summary.push(row);
      console.log("LLM_RESULT usage:", JSON.stringify(row));
    }
  }

  await result.done;
}

console.log("\n=== Cache probe summary ===");
console.table(summary);
console.log(
  "Interpretation:\n" +
    "  • If turns 2+ show cacheReadInputTokens > 0 => implicit cache is working;\n" +
    "    any nulls then correlate with status != 'completed' (the finalize race).\n" +
    "  • If turns 2+ are mostly null even when 'completed' => genuine implicit\n" +
    "    cache misses (provider best-effort), not a Copilotz bug.\n" +
    "  • Check the [cache-debug] lines: cachedContentTokenCount only on the FINAL\n" +
    "    event (with finishReason) => early-cut turns would lose it.",
);

await copilotz.shutdown();
process.exit(0);
