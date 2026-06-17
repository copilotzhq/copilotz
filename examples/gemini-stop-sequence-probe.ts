/**
 * Gemini Stop-Sequence Probe
 * ===========================
 *
 * Empirically determines how Gemini handles native stop sequences in
 * STREAMING mode, through Copilotz's real LLM pipeline (not a synthetic curl).
 *
 * Background: Copilotz forwards its client-side stop set (including the control
 * tags `<tool_results>` / `</tool_results>`) to providers that support native
 * stop handling. We observed production Gemini turns still reporting
 * `status: "locally_stopped"` with `stopSequence: "<tool_results>"`, which
 * suggests Gemini did not stop server-side. This probe confirms the behavior.
 *
 * What it does: forces the model to emit the literal `<tool_results>` tag and
 * then a long trailing essay. `<tool_results>` is ALWAYS part of Copilotz's
 * stop sequences, so:
 *   - If Gemini honors the stop server-side and strips it: the stream ends at
 *     the tag, the local matcher never fires, and the post-stop drain sees no
 *     further visible content.
 *   - If Gemini leaks the tag and keeps generating: the local matcher fires
 *     (`locally_stopped`) and the post-stop drain captures the trailing essay.
 *
 * Run with debug logging enabled (this is what surfaces the verdict):
 *   COPILOTZ_DEBUG_STOP=1 GEMINI_KEY=<key> \
 *     deno run -A --env examples/gemini-stop-sequence-probe.ts
 *
 * Watch for the `[stop-debug] ...` lines, especially
 * `[stop-debug] post-stop drain summary` → `interpretation`.
 */
import process from "node:process";
import { createCopilotz } from "../index.ts";
import type { ProviderName } from "../runtime/llm/types.ts";

const PROVIDER = (Deno.env.get("PROBE_PROVIDER") || "gemini") as ProviderName;
const DEFAULT_MODELS: Partial<Record<ProviderName, string>> = {
  gemini: "gemini-3.5-flash",
  minimax: "MiniMax-M3",
  anthropic: "claude-sonnet-4-6",
};
const MODEL = Deno.env.get("PROBE_MODEL") || DEFAULT_MODELS[PROVIDER] ||
  "gemini-3.5-flash";

const KEY_CANDIDATES: Partial<Record<ProviderName, string[]>> = {
  gemini: ["GEMINI_KEY", "GEMINI_API_KEY"],
  minimax: ["MINIMAX_KEY", "MINIMAX_API_KEY"],
  anthropic: ["ANTHROPIC_KEY", "ANTHROPIC_API_KEY"],
};
const API_KEY = (KEY_CANDIDATES[PROVIDER] ?? [])
  .map((name) => Deno.env.get(name))
  .find((value): value is string => typeof value === "string" && value.length > 0) ||
  Deno.env.get("LLM_API_KEY") || Deno.env.get("API_KEY");
if (!API_KEY) {
  console.error(
    `❌  No API key for provider '${PROVIDER}'.\n   Run with: COPILOTZ_DEBUG_STOP=1 deno run -A --env examples/gemini-stop-sequence-probe.ts`,
  );
  Deno.exit(1);
}

const copilotz = await createCopilotz({
  namespace: "examples",
  agents: [
    {
      id: "probe",
      name: "Probe",
      role: "assistant",
      // No tools on purpose: this keeps Copilotz from injecting the tool
      // protocol prompt that forbids emitting <tool_results>, so the model
      // will actually produce the tag we are probing for.
      instructions: [
        "You are a deterministic streaming test harness.",
        "When the user sends any message, respond with EXACTLY the following, in order, omitting nothing:",
        "1. The literal line: BEFORE_STOP_MARKER",
        "2. On the next line, the literal text: <tool_results>",
        "3. Immediately after, write a detailed essay of at least 200 words about the ocean.",
        "Do not add any preamble. Do not refuse. Output all three parts.",
      ].join("\n"),
      llmOptions: {
        provider: PROVIDER,
        model: MODEL,
        reasoningEffort: "medium",
        maxTokens: 4000,
        apiKey: API_KEY,
      },
    },
  ],
  dbConfig: { url: ":memory:" },
});

console.log(
  `\n=== Stop-sequence probe (provider: ${PROVIDER}, model: ${MODEL}) ===`,
);
console.log(
  "Tip: run with COPILOTZ_DEBUG_STOP=1 to see the [stop-debug] verdict lines.\n",
);

const result = await copilotz.run({
  content: "go",
  sender: { type: "user", name: "User" },
  target: "probe",
}, {
  stream: true,
});

process.stdout.write("🤖 visible tokens: ");
let visibleTokenChars = 0;

for await (const event of result.events) {
  if (event.type === "TOKEN") {
    const payload = event.payload as { token?: string; isReasoning?: boolean };
    const token = payload.token ?? "";
    if (token.length > 0 && !payload.isReasoning) {
      visibleTokenChars += token.length;
      await Deno.stdout.write(new TextEncoder().encode(token));
    }
  }

  if (event.type === "LLM_RESULT") {
    const payload = event.payload as Record<string, unknown>;
    console.log("\n\n--- LLM_RESULT ---");
    console.log(JSON.stringify(
      {
        status: payload.status,
        finishReason: payload.finishReason,
        statusReason: (payload.usage as Record<string, unknown> | undefined)
          ?.statusReason ?? payload.statusReason,
        stopSequence: (payload.usage as Record<string, unknown> | undefined)
          ?.stopSequence ?? payload.stopSequence,
        provider: payload.provider,
        model: payload.model,
      },
      null,
      2,
    ));
  }
}

await result.done;

console.log("\n=== Probe summary ===");
console.log(`Visible tokens streamed to user (chars): ${visibleTokenChars}`);
console.log(
  "Interpret the [stop-debug] lines above:\n" +
    "  • 'local stop matched' + a non-empty post-stop drain visible sample\n" +
    "    => Gemini LEAKED <tool_results> and kept generating (no server-side stop).\n" +
    "  • No 'local stop matched' and finishReason 'stop'\n" +
    "    => Gemini honored the stop server-side and stripped the tag.",
);

await copilotz.shutdown();
