import { assertEquals } from "@std/assert";
import {
  interpretAssistantResponse,
  REASONING_HISTORY_TAGS,
} from "./response-interpreter.ts";

Deno.test("interpreter accepts an answer after extracted thinking markup", () => {
  const result = interpretAssistantResponse({
    fullContent: "<think>private chain</think>Final answer",
    currentAttemptContent: "<think>private chain</think>Final answer",
    extractedBlockTags: [...REASONING_HISTORY_TAGS],
    knownToolNames: [],
    finishReason: "stop",
  });

  assertEquals(result.parsed.cleanResponse, "Final answer");
  assertEquals(result.issue, undefined);
});

Deno.test("interpreter classifies thinking-only output as empty, not leaked", () => {
  const result = interpretAssistantResponse({
    fullContent: "<thought>private chain</thought>",
    currentAttemptContent: "<thought>private chain</thought>",
    extractedBlockTags: [...REASONING_HISTORY_TAGS],
    knownToolNames: [],
    finishReason: "stop",
  });

  assertEquals(result.parsed.cleanResponse, "");
  assertEquals(result.issue, { kind: "empty_response" });
});

Deno.test("interpreter keeps canonical tool calls as intentional output", () => {
  const result = interpretAssistantResponse({
    fullContent:
      '<tool_calls>\n{"name":"search","arguments":{"q":"x"}}\n</tool_calls>',
    currentAttemptContent:
      '<tool_calls>\n{"name":"search","arguments":{"q":"x"}}\n</tool_calls>',
    extractedBlockTags: [...REASONING_HISTORY_TAGS],
    knownToolNames: ["search"],
    finishReason: "tool_calls",
  });

  assertEquals(result.issue, undefined);
  assertEquals(result.parsed.toolCalls.length, 1);
});

Deno.test("interpreter strips an imitated timestamp while preserving a later tool call", () => {
  const response = [
    "<message_timestamp>2026-07-31T21:19:51.611Z</message_timestamp>",
    "<tool_calls>",
    '{"name":"terminal","arguments":{"cmd":"pwd"}}',
    "</tool_calls>",
  ].join("\n");
  const result = interpretAssistantResponse({
    fullContent: response,
    currentAttemptContent: response,
    extractedBlockTags: [...REASONING_HISTORY_TAGS],
    knownToolNames: ["terminal"],
    finishReason: "tool_calls",
  });

  assertEquals(result.issue, undefined);
  assertEquals(result.parsed.cleanResponse, "");
  assertEquals(result.parsed.toolCalls.length, 1);
  assertEquals(result.parsed.toolCalls[0].tool.id, "terminal");
});
