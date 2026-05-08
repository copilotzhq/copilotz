import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

import { process } from "./index.ts";
import { EVENT_PRIORITIES } from "@/runtime/event-priority.ts";

Deno.test("tool_result processor converts lifecycle payload to NEW_MESSAGE artifact", async () => {
  const result = await process(
    {
      id: "evt-tool-result",
      threadId: "thread-1",
      type: "TOOL_RESULT",
      payload: {
        agent: { id: "researcher", name: "Researcher" },
        toolCallId: "call-123",
        tool: { id: "search_web", name: "Search Web" },
        args: { query: "copilotz" },
        status: "completed",
        output: { ok: true },
        projectedOutput: { summary: "done" },
        content: "Search completed",
        historyVisibility: "public_result",
        batchId: "batch-1",
        batchSize: 2,
        batchIndex: 0,
        finishedAt: new Date().toISOString(),
      },
      parentEventId: null,
      traceId: null,
      priority: 1000,
      metadata: { replyToParticipantId: "alex" },
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
    priority?: number;
  };
  assertEquals(produced.type, "NEW_MESSAGE");
  assertEquals(produced.priority, EVENT_PRIORITIES.SETTLEMENT);
  assertEquals(
    (produced.payload.sender as Record<string, unknown>)?.type,
    "tool",
  );
  assertEquals(produced.payload.content, "Search completed");
  assertEquals(
    (produced.payload.metadata as Record<string, unknown>)?.batchId,
    "batch-1",
  );
  assertEquals(
    (produced.payload.metadata as Record<string, unknown>)
      ?.toolResultQueueEventId,
    "evt-tool-result",
  );
  assertEquals(
    ((produced.payload.metadata as Record<string, unknown>)?.toolCalls as Array<
      Record<string, unknown>
    >)[0],
    {
      id: "call-123",
      tool: { id: "search_web", name: "Search Web" },
      args: { query: "copilotz" },
      output: { ok: true },
      status: "completed",
      visibility: "public_result",
      projectedOutput: { summary: "done" },
    },
  );
});

Deno.test("tool_result processor persists failed tool errors as output metadata", async () => {
  const result = await process(
    {
      id: "evt-tool-result-failed",
      threadId: "thread-1",
      type: "TOOL_RESULT",
      payload: {
        agent: { id: "researcher", name: "Researcher" },
        toolCallId: "call-failed",
        tool: { id: "browser_session", name: "Browser Session" },
        args: { sessionId: "main" },
        status: "failed",
        error: "EXECUTION ERROR: page crashed",
        content: "tool error: EXECUTION ERROR: page crashed",
        finishedAt: new Date().toISOString(),
      },
      parentEventId: null,
      traceId: null,
      priority: 1000,
      metadata: null,
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
    payload: Record<string, unknown>;
  };
  const toolCall =
    ((produced.payload.metadata as Record<string, unknown>)?.toolCalls as Array<
      Record<string, unknown>
    >)[0];

  assertEquals(toolCall.status, "failed");
  assertEquals(toolCall.error, "EXECUTION ERROR: page crashed");
  assertEquals(toolCall.output, {
    ok: false,
    status: "failed",
    error: "EXECUTION ERROR: page crashed",
  });
});
