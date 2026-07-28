import { assertEquals } from "@std/assert";
import type { ExecutableTool } from "@/runtime/tools/types.ts";
import type { ToolInvocation } from "@/runtime/llm/types.ts";
import type { Event, ProcessorDeps } from "@/types/index.ts";
import { process, processToolCalls } from "./tool_execution.created.ts";

Deno.test("processToolCalls assigns toolCallId per concurrent invocation", async () => {
  const contexts: Array<{
    toolExecutionId?: string;
    toolCallId?: string;
    traceId?: string;
    namespace?: string;
    schema?: string;
  }> = [];
  const tool: ExecutableTool = {
    id: "capture-context",
    key: "capture_context",
    name: "Capture context",
    description: "Captures tool execution context for testing.",
    inputSchema: { type: "object", additionalProperties: false },
    execute: async (_args, context) => {
      const value = context as {
        toolExecutionId?: string;
        toolCallId?: string;
        traceId?: string;
        namespace?: string;
        schema?: string;
      };
      await Promise.resolve();
      contexts.push({
        toolExecutionId: value.toolExecutionId,
        toolCallId: value.toolCallId,
        traceId: value.traceId,
        namespace: value.namespace,
        schema: value.schema,
      });
      return value.toolCallId;
    },
  };
  const calls: ToolInvocation[] = ["call-a", "call-b"].map((id) => ({
    id,
    tool: { id: tool.key },
    args: "{}",
  }));

  const results = await processToolCalls(calls, [tool], {
    traceId: "trace-1",
    namespace: "tenant-acme",
    schema: "tenant_acme",
  });

  assertEquals(
    contexts.sort((a, b) =>
      String(a.toolCallId).localeCompare(String(b.toolCallId))
    ),
    [
      {
        toolExecutionId: undefined,
        toolCallId: "call-a",
        traceId: "trace-1",
        namespace: "tenant-acme",
        schema: "tenant_acme",
      },
      {
        toolExecutionId: undefined,
        toolCallId: "call-b",
        traceId: "trace-1",
        namespace: "tenant-acme",
        schema: "tenant_acme",
      },
    ],
  );
  assertEquals(results.map((result) => result.status), [
    "completed",
    "completed",
  ]);
});

Deno.test("processToolCalls propagates a durable execution ID", async () => {
  let captured: {
    toolExecutionId?: string;
    toolCallId?: string;
    namespace?: string;
    schema?: string;
  } | undefined;
  const tool: ExecutableTool = {
    id: "capture-durable-context",
    key: "capture_durable_context",
    name: "Capture durable context",
    description: "Captures durable tool execution context for testing.",
    inputSchema: { type: "object", additionalProperties: false },
    execute: (_args, context) => {
      captured = context;
      return Promise.resolve("ok");
    },
  };

  await processToolCalls(
    [{
      id: "call-1",
      tool: { id: tool.key },
      args: "{}",
    }],
    [tool],
    {
      toolExecutionId: "execution-1",
      namespace: "tenant-acme",
      schema: "tenant_acme",
    },
  );

  assertEquals({
    toolExecutionId: captured?.toolExecutionId,
    toolCallId: captured?.toolCallId,
    namespace: captured?.namespace,
    schema: captured?.schema,
  }, {
    toolExecutionId: "execution-1",
    toolCallId: "call-1",
    namespace: "tenant-acme",
    schema: "tenant_acme",
  });
});

Deno.test("tool call processor enqueues a lifecycle fallback when finalization fails", async () => {
  const streamed: Event[] = [];
  const tool: ExecutableTool = {
    id: "return-result",
    key: "return_result",
    name: "Return result",
    description: "Returns a deterministic result.",
    inputSchema: { type: "object", additionalProperties: false },
    execute: () => Promise.resolve({ ok: true }),
  };
  const event = {
    id: "event-1",
    threadId: "thread-1",
    type: "tool_execution.created",
    subjectId: "execution-1",
    traceId: "trace-1",
    runGeneration: 3,
    metadata: {
      sourceMessageId: "message-1",
      replyToParticipantId: "agent-1",
      replyToTargetQueue: [],
    },
    payload: {
      agent: { id: "agent-1", name: "Agent 1" },
      senderId: "agent-1",
      senderType: "agent",
      toolCall: {
        id: "call-1",
        tool: { id: tool.key },
        args: "{}",
      },
    },
  } as unknown as Event;
  const deps = {
    db: {
      ops: {
        mutate: {
          toolExecutions: {
            complete: () => Promise.reject(new Error("write failed")),
          },
        },
      },
    },
    thread: { metadata: {} },
    context: {
      namespace: "tenant-acme",
      agents: [{
        id: "agent-1",
        name: "Agent 1",
        role: "assistant",
        instructions: "Use tools.",
        allowedTools: [tool.key],
        llmOptions: { provider: "openai", model: "test" },
      }],
      tools: [tool],
      usage: { enabled: false },
    },
    emitToStream: (streamEvent: Event) => streamed.push(streamEvent),
  } as unknown as ProcessorDeps;

  const result = await process(event, deps);
  const producedEvents = result?.producedEvents ?? [];

  assertEquals(producedEvents.length, 1);
  assertEquals(producedEvents[0], {
    threadId: "thread-1",
    type: "tool_execution.completed",
    payload: {
      agent: { id: "agent-1", name: "Agent 1" },
      toolCallId: "call-1",
      tool: { id: "return_result", name: undefined },
      args: "{}",
      status: "completed",
      output: { ok: true },
      content: '{"ok":true}',
      historyVisibility: "public_status",
      batchId: null,
      batchSize: null,
      batchIndex: null,
      finishedAt: producedEvents[0]?.payload &&
          typeof producedEvents[0].payload === "object"
        ? (producedEvents[0].payload as { finishedAt?: unknown }).finishedAt
        : undefined,
    },
    parentEventId: "event-1",
    traceId: "trace-1",
    priority: 3000,
    metadata: {
      toolExecutionId: "execution-1",
      sourceMessageId: "message-1",
      replyToParticipantId: "agent-1",
      replyToTargetQueue: [],
    },
  });
  assertEquals(streamed.map((streamEvent) => streamEvent.type), [
    "TOOL_CALL",
    "TOOL_RESULT",
  ]);
});
