import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildMemoryConsolidationInstruction,
  selectLongTermMemoryRange,
} from "./index.ts";

Deno.test("maintenance preserves full continuity, faithful claims and ordinary tool access", () => {
  const instruction = buildMemoryConsolidationInstruction({
    spaces: [{
      id: "own",
      name: "Own",
      scopeType: "thread",
      access: "read_write",
      defaultWrite: true,
    }],
    sourceMessages: [{
      id: "m1",
      senderType: "human",
      senderId: "human",
      text: "",
    }],
    context: [],
  });
  assertStringIncludes(instruction, "entire compacted prefix");
  assertStringIncludes(instruction, "usual tools");
  assertStringIncludes(instruction, "negation and uncertainty");
  assertStringIncludes(instruction, "message:m1");
  assertEquals(instruction.includes("kinds"), false);
});

Deno.test("range reservation keeps a chronological prefix and recent tail", () => {
  const selected = selectLongTermMemoryRange({
    messages: [
      { id: "m0", senderType: "agent", senderId: "a", text: "boundary" },
      { id: "m1", senderType: "human", senderId: "u", text: "one two three" },
      { id: "m2", senderType: "agent", senderId: "a", text: "four five six" },
      { id: "m3", senderType: "tool", senderId: "t", text: "seven eight" },
      { id: "m4", senderType: "human", senderId: "u", text: "nine ten" },
    ],
    triggerMessageId: "m4",
    previousBoundaryMessageId: "m0",
    triggerEstimatedTokens: 1,
    retainRecentEstimatedTokens: 1,
  });
  assertEquals(selected?.sourceStartMessageId, "m1");
  assertEquals(selected?.sourceEndMessageId, "m3");
});

Deno.test("a retained tool result does not retain its earlier call", () => {
  const selected = selectLongTermMemoryRange({
    messages: [
      { id: "question", senderType: "human", senderId: "u", text: "question" },
      {
        id: "call",
        senderType: "assistant",
        senderId: "north",
        text: "ask south",
        toolCalls: [{ id: "ask", action: "ask" }],
      },
      { id: "result", senderType: "tool", senderId: "ask", text: "answer" },
    ],
    triggerMessageId: "result",
    triggerEstimatedTokens: 1,
    retainRecentEstimatedTokens: 1,
  });
  assertEquals(selected?.sourceEndMessageId, "call");
  assertEquals(selected?.retainedMessageCount, 1);
});

Deno.test("a large retained message does not falsely report a full source budget", () => {
  const messages = [
    {
      id: "source",
      senderType: "human",
      senderId: "u",
      text: "s ".repeat(100_000),
    },
    {
      id: "large-tail",
      senderType: "human",
      senderId: "u",
      text: "t ".repeat(18_000),
    },
    { id: "small-tail", senderType: "human", senderId: "u", text: "small" },
  ] as const;
  const selected = selectLongTermMemoryRange({
    messages,
    triggerMessageId: "small-tail",
    triggerEstimatedTokens: 0,
    retainRecentEstimatedTokens: 8_000,
    maxSourceEstimatedTokens: 60_000,
  });
  assertEquals(selected?.sourceEndMessageId, "source");
  assertEquals(selected?.sourceLimitReached, false);
});

Deno.test("an open Ask can be summarized without waiting for its answer", () => {
  const selected = selectLongTermMemoryRange({
    messages: [
      {
        id: "call",
        senderType: "assistant",
        senderId: "north",
        text: "ask south",
        toolCalls: [{ id: "ask", action: "ask" }],
      },
      {
        id: "progress",
        senderType: "user",
        senderId: "south",
        text: "still working",
      },
    ],
    triggerMessageId: "progress",
    triggerEstimatedTokens: 1,
    retainRecentEstimatedTokens: 1,
  });
  assertEquals(selected?.sourceEndMessageId, "call");
});

Deno.test("range reservation is a safe no-op when its prior boundary is absent", () => {
  const selected = selectLongTermMemoryRange({
    messages: [
      { id: "m1", senderType: "human", senderId: "u", text: "one" },
      { id: "m2", senderType: "agent", senderId: "a", text: "two" },
    ],
    triggerMessageId: "m2",
    previousBoundaryMessageId: "missing-boundary",
    triggerEstimatedTokens: 1,
  });

  assertEquals(selected, null);
});

Deno.test("first checkpoint reserves the contiguous eligible prefix", () => {
  const selected = selectLongTermMemoryRange({
    messages: Array.from({ length: 10 }, (_, index) => ({
      id: `m${index}`,
      senderType: "human" as const,
      senderId: "u",
      text: "x",
    })),
    triggerMessageId: "m9",
    triggerEstimatedTokens: 1,
  });

  assertEquals(selected?.sourceStartMessageId, "m0");
  assertEquals(selected?.sourceEndMessageId, "m9");
});
