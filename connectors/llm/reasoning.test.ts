import {
  extractOpenAiChatStreamParts,
  geminiModelSupportsThinkingConfig,
  shouldStreamGeminiThoughts,
} from "./reasoning.ts";
import { geminiProvider } from "./providers/gemini.ts";
import type { ProviderConfig } from "./types.ts";

function assertEquals<T>(actual: T, expected: T, message?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      message ||
        `Assertion failed.\nExpected: ${JSON.stringify(expected)}\nActual: ${JSON.stringify(actual)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Gemini thinking config detection
// ---------------------------------------------------------------------------

Deno.test("geminiModelSupportsThinkingConfig is conservative", () => {
  assertEquals(geminiModelSupportsThinkingConfig("gemini-2.5-flash"), true);
  assertEquals(geminiModelSupportsThinkingConfig("gemini-3-flash-preview"), true);
  assertEquals(geminiModelSupportsThinkingConfig("gemini-2.0-flash"), false);
  assertEquals(geminiModelSupportsThinkingConfig("gemini-1.5-flash"), false);
});

Deno.test("shouldStreamGeminiThoughts respects outputReasoning and overrides", () => {
  assertEquals(
    shouldStreamGeminiThoughts(
      { outputReasoning: false } as ProviderConfig,
      "gemini-2.5-flash",
    ),
    false,
  );
  assertEquals(
    shouldStreamGeminiThoughts(
      { geminiThinkingConfig: { includeThoughts: false } } as ProviderConfig,
      "gemini-2.5-flash",
    ),
    false,
  );
  assertEquals(
    shouldStreamGeminiThoughts(
      { geminiThinkingConfig: { includeThoughts: true } } as ProviderConfig,
      "gemini-2.0-flash",
    ),
    true,
  );
});

// ---------------------------------------------------------------------------
// OpenAI Chat Completions stream extraction
// ---------------------------------------------------------------------------

Deno.test("extractOpenAiChatStreamParts handles plain content (non-reasoning)", () => {
  const parts = extractOpenAiChatStreamParts({
    choices: [{ delta: { content: "hello" } }],
  });
  assertEquals(parts, [{ text: "hello" }]);
});

Deno.test("extractOpenAiChatStreamParts returns null for empty delta", () => {
  assertEquals(
    extractOpenAiChatStreamParts({ choices: [{ delta: {} }] }),
    null,
  );
  assertEquals(
    extractOpenAiChatStreamParts({ choices: [{ delta: { content: "" } }] }),
    null,
  );
});

Deno.test("extractOpenAiChatStreamParts returns null when no choices", () => {
  assertEquals(extractOpenAiChatStreamParts({}), null);
  assertEquals(extractOpenAiChatStreamParts({ choices: [] }), null);
});

Deno.test("extractOpenAiChatStreamParts extracts reasoning_content", () => {
  const parts = extractOpenAiChatStreamParts({
    choices: [{
      delta: {
        reasoning_content: "thinking step",
        content: "answer",
      },
    }],
  });
  assertEquals(parts, [
    { text: "thinking step", isReasoning: true },
    { text: "answer" },
  ]);
});

Deno.test("extractOpenAiChatStreamParts handles reasoning_content alone (no content)", () => {
  const parts = extractOpenAiChatStreamParts({
    choices: [{ delta: { reasoning_content: "step" } }],
  });
  assertEquals(parts, [{ text: "step", isReasoning: true }]);
});

// ---------------------------------------------------------------------------
// Gemini provider integration
// ---------------------------------------------------------------------------

Deno.test("gemini provider adds thinkingConfig for 2.5 models", () => {
  const api = geminiProvider({
    apiKey: "k",
    model: "gemini-2.5-flash",
  } as ProviderConfig);
  const body = api.body([{ role: "user", content: "hi" }], {
    apiKey: "k",
    model: "gemini-2.5-flash",
  } as ProviderConfig);
  assertEquals(
    (body.generationConfig as Record<string, unknown>).thinkingConfig,
    { includeThoughts: true },
  );
});

Deno.test("gemini provider omits thinkingConfig for 2.0 default model", () => {
  const api = geminiProvider({ apiKey: "k" } as ProviderConfig);
  const body = api.body([{ role: "user", content: "hi" }], {
    apiKey: "k",
    model: "gemini-2.0-flash-lite-preview-02-05",
  } as ProviderConfig);
  assertEquals(
    (body.generationConfig as Record<string, unknown>).thinkingConfig,
    undefined,
  );
});

Deno.test("gemini extractContent tags thought parts", () => {
  const api = geminiProvider({ apiKey: "k" } as ProviderConfig);
  const parts = api.extractContent({
    candidates: [{
      content: {
        parts: [
          { thought: true, text: "internal" },
          { text: "visible" },
        ],
      },
    }],
  });
  assertEquals(parts, [
    { text: "internal", isReasoning: true },
    { text: "visible" },
  ]);
});
