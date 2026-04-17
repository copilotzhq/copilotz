import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

import { process } from "./index.ts";

Deno.test("llm_result processor converts lifecycle payload to NEW_MESSAGE artifact", async () => {
  const result = await process(
    {
      id: "evt-llm-result",
      threadId: "thread-1",
      type: "LLM_RESULT",
      payload: {
        llmCallId: "llm-123",
        agent: { id: "researcher", name: "Researcher" },
        provider: "openai",
        model: "gpt-5-mini",
        status: "completed",
        finishReason: "tool_calls",
        answer: "I will look that up.",
        reasoning: "Need to search first.",
        toolCalls: [{
          id: "call-1",
          tool: { id: "search_web", name: "Search Web" },
          args: { query: "Copilotz" },
          batchId: "batch-1",
          batchSize: 1,
          batchIndex: 0,
        }],
        usageNodeId: "usage-1",
        finishedAt: new Date().toISOString(),
      },
      parentEventId: null,
      traceId: null,
      priority: 1000,
      metadata: { targetId: "alex", targetQueue: [] },
      ttlMs: null,
      expiresAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "completed",
    } as never,
    {} as never,
  );

  assertExists(result);
  if (!("producedEvents" in result) || !result.producedEvents) {
    throw new Error("Expected producedEvents");
  }
  assertEquals(result.producedEvents.length, 1);
  const produced = result.producedEvents[0] as {
    type: string;
    payload: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  };
  assertEquals(produced.type, "NEW_MESSAGE");
  assertEquals((produced.payload.sender as Record<string, unknown>)?.type, "agent");
  assertEquals(produced.payload.content, "I will look that up.");
  assertEquals(produced.payload.reasoning, "Need to search first.");
  assertEquals(((produced.payload.toolCalls as Array<Record<string, unknown>>) ?? [])[0]?.id, "call-1");
  assertEquals(produced.metadata, {
    targetId: "alex",
    targetQueue: [],
    usageNodeId: "usage-1",
  });
});
