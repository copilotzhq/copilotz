import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

import { process } from "./llm_attempt.completed.ts";
import { EVENT_PRIORITIES } from "@/runtime/event-priority.ts";
import type { ProcessorDeps } from "@/types/index.ts";

function depsWithSupersededParent(): ProcessorDeps {
  return {
    db: {
      ops: {
        getQueueItemById: () =>
          Promise.resolve({
            id: "evt-llm-call",
            eventType: "LLM_CALL",
            createdAt: "2026-06-10T16:00:00.000Z",
            parentEventId: null,
          }),
        getNewerInterruptingEvent: () => Promise.resolve({ id: "evt-user" }),
      },
    },
    context: {},
  } as unknown as ProcessorDeps;
}

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

Deno.test("llm_result processor drops superseded assistant tool calls", async () => {
  const result = await process(
    {
      id: "evt-llm-result-stale-tools",
      threadId: "thread-1",
      type: "LLM_RESULT",
      payload: {
        llmCallId: "llm-123",
        agent: { id: "researcher", name: "Researcher" },
        provider: "openai",
        model: "gpt-5-mini",
        status: "completed",
        finishReason: "tool_calls",
        answer: "",
        reasoning: null,
        toolCalls: [{
          id: "call-1",
          tool: { id: "search_web", name: "Search Web" },
          args: { query: "stale" },
        }],
        finishedAt: new Date().toISOString(),
      },
      parentEventId: "evt-llm-call",
      traceId: null,
      priority: 1000,
      metadata: {},
      ttlMs: null,
      expiresAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "completed",
    } as never,
    depsWithSupersededParent(),
  );

  if (!result || !("producedEvents" in result) || !result.producedEvents) {
    throw new Error("Expected producedEvents");
  }
  assertEquals(result.producedEvents.length, 0);
});

Deno.test("llm_result processor marks superseded text as non-routing history", async () => {
  const result = await process(
    {
      id: "evt-llm-result-stale-text",
      threadId: "thread-1",
      type: "LLM_RESULT",
      payload: {
        llmCallId: "llm-123",
        agent: { id: "researcher", name: "Researcher" },
        provider: "openai",
        model: "gpt-5-mini",
        status: "completed",
        finishReason: "stop",
        answer: "Old answer",
        reasoning: null,
        toolCalls: null,
        finishedAt: new Date().toISOString(),
      },
      parentEventId: "evt-llm-call",
      traceId: null,
      priority: 1000,
      metadata: {},
      ttlMs: null,
      expiresAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "completed",
    } as never,
    depsWithSupersededParent(),
  );

  if (!result || !("producedEvents" in result) || !result.producedEvents) {
    throw new Error("Expected producedEvents");
  }
  assertEquals(result.producedEvents.length, 1);
  const produced = result.producedEvents[0] as {
    payload: Record<string, unknown>;
  };
  assertEquals(
    (produced.payload.metadata as Record<string, unknown>)?.skipRouting,
    true,
  );
  assertEquals(
    (produced.payload.metadata as Record<string, unknown>)
      ?.supersededSourceEventId,
    "evt-llm-call",
  );
});
