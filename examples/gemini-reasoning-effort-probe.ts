/**
 * Gemini reasoningEffort probe — verifies thinkingConfig.thinkingLevel
 * is forwarded correctly through copilotz.run().
 *
 * Run:
 *   deno run -A --env examples/gemini-reasoning-effort-probe.ts
 */
import process from "node:process";
import { assertEquals } from "@std/assert";
import { createCopilotz } from "../index.ts";
import { geminiProvider } from "../resources/llm/gemini/adapter.ts";
import type { ProviderConfig, TokenUsage } from "../runtime/llm/types.ts";

const API_KEY = Deno.env.get("GEMINI_KEY") || Deno.env.get("GEMINI_API_KEY") ||
  Deno.env.get("LLM_API_KEY") || Deno.env.get("API_KEY");
if (!API_KEY) {
  console.error("❌  Set GEMINI_KEY (or GEMINI_API_KEY) in the environment.");
  Deno.exit(1);
}

const MODEL = Deno.env.get("PROBE_MODEL") || "gemini-3.5-flash";
const ONLY_SCENARIO = Deno.args[0]; // optional: low | high | default

type CapturedRequest = {
  thinkingConfig?: Record<string, unknown>;
  model?: string;
};

function captureGeminiRequests(): {
  requests: CapturedRequest[];
  restore: () => void;
} {
  const requests: CapturedRequest[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    if (
      url.includes("generativelanguage.googleapis.com") &&
      url.includes(":streamGenerateContent")
    ) {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      requests.push({
        model: url.match(/\/models\/([^:]+):/)?.[1],
        thinkingConfig: body.generationConfig?.thinkingConfig,
      });
    }
    return originalFetch(input, init);
  };
  return {
    requests,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

async function runScenario(args: {
  label: string;
  reasoningEffort?: "low" | "high";
}): Promise<{
  label: string;
  thinkingConfig: Record<string, unknown> | undefined;
  usage: TokenUsage | undefined;
  answer: string;
}> {
  const capture = captureGeminiRequests();
  const copilotz = await createCopilotz({
    namespace: "examples",
    agents: [
      {
        id: "effort-probe",
        name: "EffortProbe",
        role: "assistant",
        instructions: "Reply in one short sentence.",
        llmOptions: {
          provider: "gemini",
          model: MODEL,
          ...(args.reasoningEffort
            ? { reasoningEffort: args.reasoningEffort }
            : {}),
          maxTokens: 200,
          apiKey: API_KEY,
        },
      },
    ],
    dbConfig: { url: ":memory:" },
  });

  let usage: TokenUsage | undefined;
  let answer = "";

  try {
    const result = await copilotz.run({
      content: "Reply with only the number 42.",
      sender: { type: "user", name: "User", id: "probe-user" },
      target: "effort-probe",
      thread: { externalId: `effort-probe-${args.label}-${crypto.randomUUID()}` },
    }, { stream: false });

    for await (const event of result.events) {
      if (event.type === "LLM_RESULT") {
        const payload = event.payload as {
          usage?: TokenUsage;
          answer?: string;
        };
        usage = payload.usage;
        answer = payload.answer ?? "";
      }
    }
    await result.done;
  } finally {
    capture.restore();
    try {
      await Promise.race([
        copilotz.shutdown(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("shutdown timeout")), 10_000)
        ),
      ]);
    } catch {
      // Best-effort shutdown for probe scripts.
    }
  }

  return {
    label: args.label,
    thinkingConfig: capture.requests[0]?.thinkingConfig,
    usage,
    answer,
  };
}

// --- Unit-level adapter checks (no network) ---
console.log("\n=== Adapter unit checks (gemini-3.5-flash) ===");
const provider = geminiProvider({ provider: "gemini", apiKey: "test" });
const messages = [{ role: "user" as const, content: "Hi" }];

for (
  const [effort, expectedLevel] of [
    ["low", "LOW"],
    ["high", "HIGH"],
    ["medium", "MEDIUM"],
    ["minimal", "MINIMAL"],
  ] as const
) {
  const body = await provider.body(messages, {
    provider: "gemini",
    apiKey: "test",
    model: MODEL,
    reasoningEffort: effort,
  });
  assertEquals(
    body.generationConfig.thinkingConfig,
    { includeThoughts: true, thinkingLevel: expectedLevel },
    `reasoningEffort=${effort}`,
  );
  console.log(`✓ reasoningEffort=${effort} → thinkingLevel=${expectedLevel}`);
}

const defaultBody = await provider.body(messages, {
  provider: "gemini",
  apiKey: "test",
  model: MODEL,
});
assertEquals(
  defaultBody.generationConfig.thinkingConfig,
  { includeThoughts: true },
  "no reasoningEffort omits thinkingLevel (Gemini server default applies)",
);
console.log("✓ no reasoningEffort → includeThoughts only (no thinkingLevel)");

// --- Live E2E via copilotz.run ---
console.log(`\n=== Live E2E via copilotz.run (model: ${MODEL}) ===\n`);

const scenarios = [
  { label: "low", reasoningEffort: "low" as const },
  { label: "high", reasoningEffort: "high" as const },
  { label: "default", reasoningEffort: undefined },
].filter((scenario) => !ONLY_SCENARIO || scenario.label === ONLY_SCENARIO);

const results = [];
for (const scenario of scenarios) {
  console.log(`Running scenario: ${scenario.label}...`);
  const row = await runScenario(scenario);
  results.push(row);
  console.log(JSON.stringify({
    scenario: row.label,
    thinkingConfig: row.thinkingConfig,
    reasoningTokens: row.usage?.reasoningTokens ?? null,
    outputTokens: row.usage?.outputTokens ?? null,
    answer: row.answer.slice(0, 80),
  }, null, 2));
  console.log("");
}

console.log("=== Summary ===");
console.table(results.map((row) => ({
  scenario: row.label,
  thinkingLevel: row.thinkingConfig?.thinkingLevel ?? "(omitted)",
  includeThoughts: row.thinkingConfig?.includeThoughts ?? null,
  reasoningTokens: row.usage?.reasoningTokens ?? null,
  outputTokens: row.usage?.outputTokens ?? null,
})));

const low = results.find((row) => row.label === "low");
const high = results.find((row) => row.label === "high");
const def = results.find((row) => row.label === "default");

let pass = true;
if (low && low.thinkingConfig?.thinkingLevel !== "LOW") {
  console.error("FAIL: low scenario did not send thinkingLevel=LOW");
  pass = false;
}
if (high && high.thinkingConfig?.thinkingLevel !== "HIGH") {
  console.error("FAIL: high scenario did not send thinkingLevel=HIGH");
  pass = false;
}
if (def && def.thinkingConfig?.thinkingLevel !== undefined) {
  console.error(
    "FAIL: default scenario unexpectedly sent thinkingLevel (should rely on Gemini default)",
  );
  pass = false;
}
if (
  typeof low?.usage?.reasoningTokens === "number" &&
  typeof high?.usage?.reasoningTokens === "number" &&
  low.usage.reasoningTokens >= high.usage.reasoningTokens
) {
  console.warn(
    "WARN: low reasoningTokens >= high — effort may not affect token budget on this model/prompt",
  );
}

if (pass) {
  console.log("\n✅ reasoningEffort is forwarded correctly to Gemini thinkingConfig.");
} else {
  Deno.exit(1);
}

process.exit(0);
