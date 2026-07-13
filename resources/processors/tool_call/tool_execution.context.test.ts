import { assertEquals } from "@std/assert";
import type { ExecutableTool } from "@/runtime/tools/types.ts";
import type { ToolInvocation } from "@/runtime/llm/types.ts";
import { processToolCalls } from "./tool_execution.created.ts";

Deno.test("processToolCalls assigns toolCallId per concurrent invocation", async () => {
  const contexts: Array<{ toolCallId?: string; traceId?: string }> = [];
  const tool: ExecutableTool = {
    id: "capture-context",
    key: "capture_context",
    name: "Capture context",
    description: "Captures tool execution context for testing.",
    inputSchema: { type: "object", additionalProperties: false },
    execute: async (_args, context) => {
      const value = context as { toolCallId?: string; traceId?: string };
      await Promise.resolve();
      contexts.push({
        toolCallId: value.toolCallId,
        traceId: value.traceId,
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
  });

  assertEquals(
    contexts.sort((a, b) =>
      String(a.toolCallId).localeCompare(String(b.toolCallId))
    ),
    [
      { toolCallId: "call-a", traceId: "trace-1" },
      { toolCallId: "call-b", traceId: "trace-1" },
    ],
  );
  assertEquals(results.map((result) => result.status), [
    "completed",
    "completed",
  ]);
});
