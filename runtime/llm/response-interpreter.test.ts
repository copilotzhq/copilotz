import { assertEquals } from "@std/assert";
import {
  interpretAssistantResponse,
  REASONING_HISTORY_TAGS,
} from "@/runtime/llm/response-interpreter.ts";

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
