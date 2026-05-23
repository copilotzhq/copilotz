/**
 * Live Copilotz chat smoke test for Gemini streaming explicit cache usage.
 *
 * This creates a Gemini cachedContent resource, calls the normal Copilotz
 * chat() path with promptCache.cachedContent, and prints the normalized usage.
 *
 * Usage:
 *   deno run -A --env-file=.env scripts/gemini-chat-explicit-cache-smoke.ts gemini-3.1-flash-lite
 */

import { chat } from "@/runtime/llm/index.ts";
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

type JsonRecord = Record<string, unknown>;

const repeatedPrefix = Array.from(
  { length: lineCount },
  (_, i) =>
    `Stable cached context line ${
      i + 1
    }: This exact prefix should be served from explicit cachedContent.`,
).join("\n");

let cacheName: string | null = null;

try {
  const createResponse = await request<JsonRecord>(
    `${baseUrl}/cachedContents?key=${apiKey}`,
    {
      method: "POST",
      body: {
        model: modelRef,
        systemInstruction: {
          role: "system",
          parts: [{
            text:
              "You are a concise assistant. Use the cached context when answering.",
          }],
        },
        contents: [{
          role: "user",
          parts: [{ text: repeatedPrefix }],
        }],
        ttl: "300s",
      },
    },
  ) as { data: JsonRecord };

  cacheName = typeof createResponse.data.name === "string"
    ? createResponse.data.name
    : null;
  if (!cacheName) {
    throw new Error(
      `Cache creation did not return a name: ${
        JSON.stringify(createResponse.data)
      }`,
    );
  }

  const response = await chat(
    {
      messages: [{
        role: "user",
        content: "Reply with exactly: ok",
      }],
    },
    {
      provider: "gemini",
      model,
      apiKey,
      maxTokens: 8,
      outputReasoning: false,
      promptCache: {
        mode: "explicit",
        cachedContent: cacheName,
      },
    },
    env,
  );

  console.log(JSON.stringify(
    {
      model,
      cacheName,
      createUsage: createResponse.data.usageMetadata ??
        createResponse.data.usage_metadata ?? null,
      answer: response.answer,
      finishReason: response.finishReason,
      usage: response.usage ?? null,
    },
    null,
    2,
  ));
} finally {
  if (cacheName) {
    try {
      await request(`${baseUrl}/${cacheName}?key=${apiKey}`, {
        method: "DELETE",
      });
    } catch {
      // Ignore cleanup failures in smoke tests.
    }
  }
}
