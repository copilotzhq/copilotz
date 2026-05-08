import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

import { process } from "./index.ts";
import { EVENT_PRIORITIES } from "@/runtime/event-priority.ts";

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
    priority?: number;
  };
  assertEquals(produced.type, "NEW_MESSAGE");
  assertEquals(produced.priority, EVENT_PRIORITIES.SETTLEMENT);
  assertEquals(
    (produced.payload.sender as Record<string, unknown>)?.type,
    "agent",
  );
  assertEquals(produced.payload.content, "I will look that up.");
  assertEquals(produced.payload.reasoning, "Need to search first.");
  assertEquals(
    ((produced.payload.toolCalls as Array<Record<string, unknown>>) ?? [])[0]
      ?.id,
    "call-1",
  );
  assertEquals(produced.metadata, {
    targetId: "alex",
    targetQueue: [],
    usageNodeId: "usage-1",
  });
});

Deno.test("llm_result processor renders failed LLM results as assistant messages", async () => {
  const result = await process(
    {
      id: "evt-llm-failed",
      threadId: "thread-1",
      type: "LLM_RESULT",
      payload: {
        llmCallId: "llm-123",
        agent: { id: "researcher", name: "Researcher" },
        provider: "anthropic",
        model: "claude",
        status: "failed",
        finishReason: "error",
        answer: "O modelo está temporariamente com limite de uso.",
        reasoning: null,
        toolCalls: null,
        extractedTags: null,
        error: {
          message: "Request failed with status 429",
          reason: "rate_limit",
          provider: "anthropic",
          model: "claude",
          status: 429,
          retryable: true,
          fallbackAttempted: false,
          fallbackCount: 0,
          visibleStreamStarted: false,
          attempts: [{
            provider: "anthropic",
            model: "claude",
            reason: "rate_limit",
            status: 429,
            message: "Request failed with status 429",
          }],
        },
        finishedAt: new Date().toISOString(),
      },
      parentEventId: null,
      traceId: null,
      priority: 1000,
      metadata: {},
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
  const produced = result.producedEvents[0] as {
    type: string;
    payload: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  };
  assertEquals(produced.type, "NEW_MESSAGE");
  assertEquals(
    produced.payload.content,
    "O modelo está temporariamente com limite de uso.",
  );
  assertEquals(
    (produced.metadata?.llmError as Record<string, unknown>)?.reason,
    "rate_limit",
  );
});
