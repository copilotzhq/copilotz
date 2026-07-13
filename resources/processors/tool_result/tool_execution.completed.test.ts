import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

import { process } from "./tool_execution.completed.ts";
import { EVENT_PRIORITIES } from "@/runtime/event-priority.ts";
import type { ProcessorDeps } from "@/types/index.ts";
import { disconnectJqWorker } from "@/runtime/tools/jq.ts";

function depsWithSupersededParent(): ProcessorDeps {
  return {
    db: {
      ops: {
        getQueueItemById: () =>
          Promise.resolve({
            id: "evt-tool-call",
            eventType: "TOOL_CALL",
            createdAt: "2026-06-10T16:00:00.000Z",
            parentEventId: null,
          }),
        getNewerInterruptingEvent: () => Promise.resolve({ id: "evt-user" }),
      },
    },
    context: {},
  } as unknown as ProcessorDeps;
}

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
        content: "Search completed",
        historyVisibility: "public",
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
      visibility: "public",
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

Deno.test("tool_result processor marks superseded results as non-routing history", async () => {
  const result = await process(
    {
      id: "evt-tool-result-stale",
      threadId: "thread-1",
      type: "TOOL_RESULT",
      payload: {
        agent: { id: "researcher", name: "Researcher" },
        toolCallId: "call-123",
        tool: { id: "search_web", name: "Search Web" },
        args: { query: "copilotz" },
        status: "completed",
        output: { ok: true },
        content: "Search completed",
        finishedAt: new Date().toISOString(),
      },
      parentEventId: "evt-tool-call",
      traceId: null,
      priority: 1000,
      metadata: null,
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
  const metadata = produced.payload.metadata as Record<string, unknown>;

  assertEquals(metadata.skipRouting, true);
  assertEquals(metadata.supersededSourceEventId, "evt-tool-call");
  assertEquals(
    ((metadata.toolCalls as Array<Record<string, unknown>>) ?? [])[0]?.id,
    "call-123",
  );
});

Deno.test("tool_result processor advances a pipeline with deep-merged arguments", async () => {
  const created: Array<Record<string, unknown>> = [];
  const result = await process(
    {
      id: "evt-stage-1-completed",
      threadId: "thread-1",
      type: "tool_execution.completed",
      payload: {
        agent: { id: "researcher", name: "Researcher" },
        toolCallId: "call-stage-1",
        tool: { id: "extract", name: "Extract" },
        args: {},
        status: "completed",
        output: {
          customer: { id: "123", status: "new" },
          tags: ["imported"],
        },
        content: "extracted",
        batchId: "batch-1",
        batchSize: 2,
        batchIndex: 0,
        finishedAt: new Date().toISOString(),
      },
      parentEventId: null,
      traceId: "trace-1",
      metadata: {
        toolExecutionId: "execution-1",
        sourceMessageId: "message-1",
        replyToParticipantId: "researcher",
        toolPipeline: {
          id: "pipeline-1",
          stageIndex: 0,
          rootToolCallId: "call-stage-1",
          stages: [
            {
              type: "tool",
              id: "call-stage-1",
              tool: { id: "extract" },
              args: "{}",
            },
            {
              type: "tool",
              id: "call-stage-2",
              tool: { id: "analyze", name: "Analyze" },
              args:
                '{"customer":{"status":"priority"},"tags":["manual"],"notify":true}',
            },
          ],
        },
      },
    } as never,
    {
      db: {
        ops: {
          mutate: {
            toolExecutions: {
              create: (input: Record<string, unknown>) => {
                created.push(input);
                return Promise.resolve({ id: "execution-2" });
              },
            },
          },
        },
      },
      context: { namespace: "tenant" },
    } as unknown as ProcessorDeps,
  );

  assertEquals(result, { producedEvents: [] });
  assertEquals(created.length, 1);
  assertEquals(created[0].toolCallId, "call-stage-2");
  assertEquals(JSON.parse(String(created[0].args)), {
    customer: { id: "123", status: "priority" },
    tags: ["manual"],
    notify: true,
  });
  assertEquals(
    ((created[0].metadata as Record<string, unknown>).toolPipeline as Record<
      string,
      unknown
    >).stageIndex,
    1,
  );
});

Deno.test("tool_result processor settles a final pipeline stage against the root call id", async () => {
  const result = await process(
    {
      id: "evt-stage-2-completed",
      threadId: "thread-1",
      type: "tool_execution.completed",
      payload: {
        agent: { id: "researcher", name: "Researcher" },
        toolCallId: "call-stage-2",
        tool: { id: "analyze", name: "Analyze" },
        args: { records: [] },
        status: "completed",
        output: { summary: "done" },
        content: "done",
        finishedAt: new Date().toISOString(),
      },
      parentEventId: null,
      metadata: {
        toolExecutionId: "execution-2",
        toolPipeline: {
          id: "pipeline-1",
          stageIndex: 1,
          rootToolCallId: "call-stage-1",
          stages: [
            {
              type: "tool",
              id: "call-stage-1",
              tool: { id: "extract" },
              args: "{}",
            },
            {
              type: "tool",
              id: "call-stage-2",
              tool: { id: "analyze" },
              args: "{}",
            },
          ],
        },
      },
    } as never,
    { context: {}, db: { ops: {} } } as unknown as ProcessorDeps,
  );

  const produced =
    (result as { producedEvents: Array<Record<string, unknown>> })
      .producedEvents[0];
  const metadata = (produced.payload as Record<string, unknown>)
    .metadata as Record<string, unknown>;
  assertEquals(
    (metadata.toolCalls as Array<Record<string, unknown>>)[0].id,
    "call-stage-1",
  );
});

Deno.test({
  name:
    "tool_result processor stores a final jq projection and settles the lane",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const updates: Array<Record<string, unknown>> = [];
    try {
      const result = await process(
        {
          id: "evt-stage-final",
          threadId: "thread-1",
          type: "tool_execution.completed",
          payload: {
            agent: { id: "researcher", name: "Researcher" },
            toolCallId: "call-stage-1",
            tool: { id: "extract", name: "Extract" },
            args: {},
            status: "completed",
            output: { records: [{ id: 1 }, { id: 2 }] },
            content: "raw",
            finishedAt: new Date().toISOString(),
          },
          parentEventId: null,
          traceId: "trace-1",
          metadata: {
            toolExecutionId: "execution-1",
            toolPipeline: {
              id: "pipeline-1",
              stageIndex: 0,
              rootToolCallId: "call-stage-1",
              stages: [
                {
                  type: "tool",
                  id: "call-stage-1",
                  tool: { id: "extract" },
                  args: "{}",
                },
                { type: "jq", filter: ".records | map(.id)" },
              ],
            },
          },
        } as never,
        {
          db: {
            ops: {
              mutate: {
                toolExecutions: {
                  update: (_id: string, patch: Record<string, unknown>) => {
                    updates.push(patch);
                    return Promise.resolve({ id: "execution-1" });
                  },
                },
              },
            },
          },
          context: {},
        } as unknown as ProcessorDeps,
      );

      assertExists(result);
      assertEquals(updates[0].projectedOutput, [1, 2]);
      const produced =
        (result as { producedEvents: Array<Record<string, unknown>> })
          .producedEvents[0];
      const message = produced.payload as Record<string, unknown>;
      assertEquals(message.content, "[1,2]");
      assertEquals(
        ((message.metadata as Record<string, unknown>).toolCalls as Array<
          Record<string, unknown>
        >)[0].output,
        [1, 2],
      );
    } finally {
      disconnectJqWorker();
    }
  },
});

Deno.test("tool_result processor settles non-object pipeline output as a failure", async () => {
  const updates: Array<Record<string, unknown>> = [];
  const result = await process(
    {
      id: "evt-stage-invalid-output",
      threadId: "thread-1",
      type: "tool_execution.completed",
      payload: {
        agent: { id: "researcher", name: "Researcher" },
        toolCallId: "call-stage-1",
        tool: { id: "extract", name: "Extract" },
        args: {},
        status: "completed",
        output: "plain text",
        content: "plain text",
        finishedAt: new Date().toISOString(),
      },
      parentEventId: null,
      metadata: {
        toolExecutionId: "execution-1",
        toolPipeline: {
          id: "pipeline-1",
          stageIndex: 0,
          rootToolCallId: "call-stage-1",
          stages: [
            {
              type: "tool",
              id: "call-stage-1",
              tool: { id: "extract" },
              args: "{}",
            },
            {
              type: "tool",
              id: "call-stage-2",
              tool: { id: "analyze" },
              args: "{}",
            },
          ],
        },
      },
    } as never,
    {
      db: {
        ops: {
          mutate: {
            toolExecutions: {
              update: (_id: string, patch: Record<string, unknown>) => {
                updates.push(patch);
                return Promise.resolve({ id: "execution-1" });
              },
            },
          },
        },
      },
      context: {},
    } as unknown as ProcessorDeps,
  );

  assertEquals(updates.length, 1);
  const failure = (updates[0].metadata as Record<string, unknown>)
    .pipelineFailure as Record<string, unknown>;
  assertEquals(failure.stageIndex, 1);

  const produced =
    (result as { producedEvents: Array<Record<string, unknown>> })
      .producedEvents[0];
  const message = produced.payload as Record<string, unknown>;
  const toolCall =
    ((message.metadata as Record<string, unknown>).toolCalls as Array<
      Record<string, unknown>
    >)[0];
  assertEquals(toolCall.id, "call-stage-1");
  assertEquals(toolCall.status, "failed");
  assertEquals(
    String(toolCall.error).includes("Pipeline output must be an object"),
    true,
  );
});
