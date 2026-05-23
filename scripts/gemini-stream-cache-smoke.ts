/**
 * Live smoke test for Gemini streaming cache accounting.
 *
 * This bypasses Copilotz's LLM abstraction and parses Google's raw SSE stream
 * directly, so it can distinguish provider behavior from local parser bugs.
 *
 * Usage:
 *   deno run -A --env-file=.env scripts/gemini-stream-cache-smoke.ts gemini-3.1-flash-lite implicit
 *   deno run -A --env-file=.env scripts/gemini-stream-cache-smoke.ts gemini-3.1-pro-preview explicit
 */

import { request } from "@/runtime/http.ts";

const env = Deno.env.toObject();
const apiKey = env.GEMINI_API_KEY || env.GEMINI_KEY;
if (!apiKey) {
  console.error("GEMINI_API_KEY or GEMINI_KEY is required");
  Deno.exit(1);
}

const model = Deno.args[0] || "gemini-3.1-flash-lite";
const mode = Deno.args[1] === "explicit" ? "explicit" : "implicit";
const lineCount = Number(Deno.args[2] ?? "800");
const modelRef = model.startsWith("models/") ? model : `models/${model}`;
const baseUrl = "https://generativelanguage.googleapis.com/v1beta";

type JsonRecord = Record<string, unknown>;

const repeatedPrefix = Array.from(
  { length: lineCount },
  (_, i) =>
    `Stable cached context line ${
      i + 1
    }: This exact prefix should remain byte-for-byte identical across streaming requests.`,
).join("\n");

function extractParts(data: JsonRecord): unknown {
  return ((data.candidates as Array<JsonRecord> | undefined)?.[0]
    ?.content as JsonRecord | undefined)?.parts ?? null;
}

function extractFinishReason(data: JsonRecord): unknown {
  return (data.candidates as Array<JsonRecord> | undefined)?.[0]
    ?.finishReason ??
    null;
}

async function readGeminiSse(response: Response) {
  if (!response.body) throw new Error("Response did not include a body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: JsonRecord[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;

      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;

      try {
        events.push(JSON.parse(payload) as JsonRecord);
      } catch (error) {
        events.push({
          parseError: error instanceof Error ? error.message : String(error),
          rawPrefix: payload.slice(0, 200),
        });
      }
    }
  }

  if (buffer.trim().startsWith("data:")) {
    const payload = buffer.trim().slice(5).trim();
    if (payload && payload !== "[DONE]") {
      events.push(JSON.parse(payload) as JsonRecord);
    }
  }

  return events;
}

async function streamGenerate(body: JsonRecord) {
  const startedAt = Date.now();
  const response = await fetch(
    `${baseUrl}/${modelRef}:streamGenerateContent?key=${
      encodeURIComponent(apiKey)
    }&alt=sse`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );

  const events = await readGeminiSse(response);
  const usageEvents = events
    .map((event, index) => ({ index, usageMetadata: event.usageMetadata }))
    .filter((event) => event.usageMetadata);
  const finalEvent = events.at(-1) ?? null;

  return {
    latencyMs: Date.now() - startedAt,
    status: response.status,
    eventCount: events.length,
    usageEvents,
    finalEventSummary: finalEvent
      ? {
        hasUsageMetadata: Boolean(finalEvent.usageMetadata),
        finishReason: extractFinishReason(finalEvent),
        parts: extractParts(finalEvent),
        usageMetadata: finalEvent.usageMetadata ?? null,
      }
      : null,
  };
}

async function runImplicit() {
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

  return {
    mode,
    lineCount,
    results: [
      await streamGenerate(body),
      await streamGenerate(body),
      await streamGenerate(body),
    ],
  };
}

async function runExplicit() {
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

    return {
      mode,
      lineCount,
      cacheName,
      createUsage: createResponse.data.usageMetadata ??
        createResponse.data.usage_metadata ?? null,
      result: await streamGenerate({
        contents: [{
          role: "user",
          parts: [{ text: "Reply with exactly: ok" }],
        }],
        cachedContent: cacheName,
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 8,
        },
      }),
    };
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
}

const result = mode === "explicit" ? await runExplicit() : await runImplicit();
console.log(JSON.stringify({ model, ...result }, null, 2));
