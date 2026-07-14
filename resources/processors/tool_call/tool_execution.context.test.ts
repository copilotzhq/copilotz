import { assertEquals } from "@std/assert";
import type { ExecutableTool } from "@/runtime/tools/types.ts";
import type { ToolInvocation } from "@/runtime/llm/types.ts";
import { processToolCalls } from "./tool_execution.created.ts";

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
