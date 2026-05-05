import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

import {
  formatMessages,
  getLocalStopSequences,
  parseToolCallsFromResponse,
} from "./utils.ts";

Deno.test("formatMessages limits non-system history using estimated input tokens", () => {
  const formatted = formatMessages({
    messages: [
      { role: "user", content: "12345678" }, // 2 tokens
      { role: "assistant", content: "abcdefgh" }, // 2 tokens
      { role: "user", content: "ijklmnop" }, // 2 tokens
    ],
    config: {
      limitEstimatedInputTokens: 4,
    },
  });

  assertEquals(
    formatted.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    [
      { role: "assistant", content: "abcdefgh" },
      { role: "user", content: "ijklmnop" },
    ],
  );
});

Deno.test("formatMessages preserves the system prompt outside the estimated input history budget", () => {
  const formatted = formatMessages({
    messages: [
      { role: "user", content: "12345678" }, // 2 tokens
      { role: "assistant", content: "abcdefgh" }, // 2 tokens
    ],
    instructions: "system", // 2 tokens
    config: {
      limitEstimatedInputTokens: 4,
    },
  });

  assertEquals(
    formatted.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    [
      { role: "system", content: "system" },
      { role: "assistant", content: "abcdefgh" },
    ],
  );
});

Deno.test("formatMessages trims the oldest included text message to fit the remaining estimated budget", () => {
  const formatted = formatMessages({
    messages: [
      { role: "user", content: "12345678" }, // 2 tokens
      { role: "assistant", content: "abcdefghijkl" }, // 3 tokens
    ],
    config: {
      limitEstimatedInputTokens: 4,
    },
  });

  assertEquals(
    formatted.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    [
      { role: "user", content: "5678" },
      { role: "assistant", content: "abcdefghijkl" },
    ],
  );
});

Deno.test("getLocalStopSequences stops both function results tag forms", () => {
  assertEquals(
    getLocalStopSequences(),
    ["<function_results>", "</function_results>"],
  );
});

Deno.test("parseToolCallsFromResponse strips incomplete function calls after local stop", () => {
  const parsed = parseToolCallsFromResponse(
    '<function_calls>\n{"name":"saveThreadContext","arguments":{"threadData":{"step":"Direção Criativa"}}}\n',
  );

  assertEquals(parsed.cleanResponse, "");
  assertEquals(parsed.tool_calls.length, 1);
  assertEquals(parsed.tool_calls[0].tool.id, "saveThreadContext");
  assertEquals(
    JSON.parse(parsed.tool_calls[0].args as string),
    { threadData: { step: "Direção Criativa" } },
  );
});

Deno.test("formatMessages counts structured tool result output toward input limit", () => {
  const hugeBody = "x".repeat(8000);
  const formatted = formatMessages({
    messages: [
      { role: "user", content: "first" },
      {
        role: "tool",
        content: "",
        toolCalls: [{
          id: "call_1",
          tool: { id: "http_request" },
          args: "{}",
          output: { body: hugeBody },
        }],
      },
    ],
    config: {
      limitEstimatedInputTokens: 500,
    },
  });

  const assistantTurns = formatted.filter((m) => m.role === "assistant");
  assertEquals(assistantTurns.length >= 1, true);
  const toolWire = assistantTurns[assistantTurns.length - 1];
  assertEquals(typeof toolWire.content, "string");
  const wire = toolWire.content as string;
  // Budget is 500 est. tokens → ~2000 chars; tail-slice may omit the opening
  // `<function_results>` tag but must not retain the full tool JSON.
  assertEquals(wire.length <= 2100, true);
  assertEquals(wire.includes(hugeBody), false);
});
