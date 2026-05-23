/**
 * Live smoke test for Gemini implicit context caching using non-streaming
 * generateContent calls.
 *
 * Usage:
 *   deno run -A --env-file=.env scripts/gemini-implicit-cache-smoke.ts gemini-3.1-flash-lite
 *   deno run -A --env-file=.env scripts/gemini-implicit-cache-smoke.ts gemini-3.1-pro-preview
 */
import { request } from "@/runtime/http.ts";

const env = Deno.env.toObject();
const apiKey = env.GEMINI_API_KEY || env.GEMINI_KEY;
if (!apiKey) {
  console.error("GEMINI_API_KEY or GEMINI_KEY is required");
  Deno.exit(1);
}

const model = Deno.args[0] || "gemini-3.1-flash-lite";
const lineCount = Number(Deno.args[1] ?? "800");
const modelRef = model.startsWith("models/") ? model : `models/${model}`;
const baseUrl = "https://generativelanguage.googleapis.com/v1beta";

const repeatedPrefix = Array.from(
  { length: lineCount },
  (_, i) =>
    `Stable cached context line ${
      i + 1
    }: This exact prefix should remain byte-for-byte identical across requests.`,
).join("\n");

const body = {
  systemInstruction: {
    parts: [{
      text: [
        "You are a concise assistant.",
        "This request intentionally includes a long repeated prefix to test Gemini implicit context caching.",
      ].join("\n"),
    }],
  },
  contents: [{
    role: "user",
    parts: [{
      text: [
        repeatedPrefix,
        "Reply with exactly: ok",
      ].join("\n\n"),
    }],
  }],
  generationConfig: {
    temperature: 0,
    maxOutputTokens: 8,
  },
};

type JsonRecord = Record<string, unknown>;

async function runOnce(label: string) {
  const startedAt = Date.now();
  const response = await request<JsonRecord>(
    `${baseUrl}/${modelRef}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      body,
    },
  ) as { data: JsonRecord };
  const usageMetadata = (response.data.usageMetadata ??
    response.data.usage_metadata) as JsonRecord | undefined;
  const parts = ((response.data.candidates as Array<JsonRecord> | undefined)
    ?.[0]?.content as JsonRecord | undefined)?.parts;

  return {
    label,
    latencyMs: Date.now() - startedAt,
    usageMetadata: usageMetadata ?? null,
    answer: parts ?? null,
  };
}

const results = [];
for (const label of ["first", "second", "third"]) {
  results.push(await runOnce(label));
}

console.log(JSON.stringify({ model, lineCount, results }, null, 2));
