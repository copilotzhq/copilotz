/**
 * Live smoke test for Gemini explicit cached content.
 *
 * Usage:
 *   deno run -A --env-file=../../clients/mobizap/.env scripts/gemini-explicit-cache-smoke.ts
 *   deno run -A --env-file=../../clients/mobizap/.env scripts/gemini-explicit-cache-smoke.ts gemini-3.1-flash-lite-preview
 */
import { request } from "../connectors/request/index.ts";

const env = Deno.env.toObject();
const apiKey = env.GEMINI_API_KEY || env.GEMINI_KEY;
if (!apiKey) {
  console.error("GEMINI_API_KEY or GEMINI_KEY is required");
  Deno.exit(1);
}

const model = Deno.args[0] || "gemini-3.1-flash-lite-preview";
const modelRef = model.startsWith("models/") ? model : `models/${model}`;
const baseUrl = "https://generativelanguage.googleapis.com/v1beta";

const repeatedPrefix = Array.from({ length: 450 }, (_, i) =>
  `Instruction ${i + 1}: Keep this exact line as cached context for later questions.`
).join("\n");

const cacheRequest = {
  model: modelRef,
  systemInstruction: {
    role: "system",
    parts: [{
      text: "You are a concise assistant. Use the cached context when answering.",
    }],
  },
  contents: [{
    role: "user",
    parts: [{
      text: repeatedPrefix,
    }],
  }],
  ttl: "300s",
};

type JsonRecord = Record<string, unknown>;

let cacheName: string | null = null;

try {
  const createResponse = await request<JsonRecord>(
    `${baseUrl}/cachedContents?key=${apiKey}`,
    {
      method: "POST",
      body: cacheRequest,
    },
  ) as { data: JsonRecord };

  const createdCache = createResponse.data;
  cacheName = typeof createdCache.name === "string" ? createdCache.name : null;
  if (!cacheName) {
    throw new Error(`Cache creation did not return a name: ${JSON.stringify(createdCache)}`);
  }

  const generateResponse = await request<JsonRecord>(
    `${baseUrl}/${modelRef}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      body: {
        contents: [{
          role: "user",
          parts: [{ text: "Reply with exactly: ok" }],
        }],
        cachedContent: cacheName,
      },
    },
  ) as { data: JsonRecord };

  const usageMetadata = (generateResponse.data.usageMetadata ??
    generateResponse.data.usage_metadata) as JsonRecord | undefined;

  console.log(JSON.stringify({
    model,
    cacheName,
    createUsage: createdCache.usageMetadata ?? createdCache.usage_metadata ?? null,
    generateUsage: usageMetadata ?? null,
    answer: ((generateResponse.data.candidates as Array<JsonRecord> | undefined)?.[0]
      ?.content as JsonRecord | undefined)?.parts ?? null,
  }, null, 2));
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
