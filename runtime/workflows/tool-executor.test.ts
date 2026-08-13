import { assertEquals } from "@std/assert";

import type { CopilotzProcessorContext } from "../engine/index.ts";
import type { EphemeralEvent } from "../events/index.ts";
import type { WorkflowTool } from "./types.ts";
import { createWorkflowToolExecutor } from "./tool-executor.ts";

function fixture(
  execute: WorkflowTool["execute"],
): Readonly<{
  run: ReturnType<typeof createWorkflowToolExecutor>;
  tool: WorkflowTool;
  context: CopilotzProcessorContext;
  events: EphemeralEvent[];
}> {
  const events: EphemeralEvent[] = [];
  const tool: WorkflowTool = {
    id: "terminal",
    key: "terminal",
    name: "Terminal",
    description: "Test terminal.",
    inputSchema: { type: "object" },
    execute,
  };
  const context = {
    namespace: "tenant-a",
    databaseSchema: "copilotz_test",
    signal: new AbortController().signal,
    idempotencyKey: "delivery-a",
    event: {
      durable: true,
      id: "event-a",
      position: "1",
      schemaVersion: 1,
      type: "tool_execution.created",
      namespace: "tenant-a",
      threadId: "thread-a",
      payload: {},
      routing: { senderId: "agent-a" },
      visibility: {
        kind: "tool",
        policy: "public_status",
        requesterId: "agent-a",
      },
      metadata: {},
      correlationId: "correlation-a",
      createdAt: "2026-08-13T12:00:00.000Z",
    },
    events: {
      emit(input: Record<string, unknown>) {
        events.push({
          durable: false,
          namespace: "tenant-a",
          correlationId: "correlation-a",
          routing: {},
          visibility: { kind: "public" },
          metadata: {},
          createdAt: "2026-08-13T12:00:00.000Z",
          ...input,
        } as EphemeralEvent);
        return Promise.resolve(events.at(-1)!);
      },
    },
    resources: {
      list: () => [tool],
      get: () => undefined,
    },
    conversation: {
      getParticipant: () =>
        Promise.resolve({ id: "agent-a", externalId: "north" }),
      getThread: () => Promise.resolve({ participants: [] }),
    },
    collections: {},
    content: {
      get: () => Promise.resolve(null),
      resolve: () =>
        Promise.resolve({
          bytes: new Uint8Array(),
          ref: {
            assetId: "asset-a",
            kind: "file",
            role: "attachment",
            mediaType: "text/plain",
          },
        }),
    },
  } as unknown as CopilotzProcessorContext;
  return Object.freeze({
    run: createWorkflowToolExecutor(),
    tool,
    context,
    events,
  });
}

Deno.test("tool executor orders explicit output chunks and emits a final result snapshot", async () => {
  const test = fixture((_args, context) => {
    void context!.emitOutput("one", { channel: "stdout" });
    void context!.emitOutput("two", { channel: "stderr" });
    return Promise.resolve({ stdout: "one", stderr: "two", exitCode: 0 });
  });

  const outcome = await test.run({
    execution: {
      id: "execution-a",
      namespace: "tenant-a",
      threadId: "thread-a",
      participantId: "agent-a",
      toolCallId: "call-a",
      tool: { id: "terminal", name: "Terminal" },
      status: "running",
      content: [],
      startedAt: "2026-08-13T12:00:00.000Z",
      metadata: {},
      createdAt: "2026-08-13T12:00:00.000Z",
      updatedAt: "2026-08-13T12:00:00.000Z",
    },
    tool: test.tool,
    availableTools: [test.tool],
    arguments: {},
    context: test.context,
  });

  assertEquals(outcome.status, "completed");
  assertEquals(test.events.map((event) => event.type), [
    "tool_output.delta",
    "tool_output.delta",
    "tool_output.delta",
  ]);
  assertEquals(test.events.map((event) => event.sequence), [0, 1, 2]);
  assertEquals(test.events.map((event) => event.payload), [{
    toolExecutionId: "execution-a",
    toolCallId: "call-a",
    toolId: "terminal",
    toolName: "Terminal",
    channel: "stdout",
    mode: "append",
    delta: "one",
  }, {
    toolExecutionId: "execution-a",
    toolCallId: "call-a",
    toolId: "terminal",
    toolName: "Terminal",
    channel: "stderr",
    mode: "append",
    delta: "two",
  }, {
    toolExecutionId: "execution-a",
    toolCallId: "call-a",
    toolId: "terminal",
    toolName: "Terminal",
    channel: "result",
    mode: "replace",
    delta: { stdout: "one", stderr: "two", exitCode: 0 },
  }]);
});

Deno.test("an explicit result channel prevents duplicate automatic output", async () => {
  const result = { progress: 100 };
  const test = fixture(async (_args, context) => {
    await context!.emitOutput(result, { channel: "result" });
    return result;
  });

  await test.run({
    execution: {
      id: "execution-a",
      namespace: "tenant-a",
      threadId: "thread-a",
      participantId: "agent-a",
      toolCallId: "call-a",
      tool: { id: "terminal", name: "Terminal" },
      status: "running",
      content: [],
      startedAt: "2026-08-13T12:00:00.000Z",
      metadata: {},
      createdAt: "2026-08-13T12:00:00.000Z",
      updatedAt: "2026-08-13T12:00:00.000Z",
    },
    tool: test.tool,
    availableTools: [test.tool],
    arguments: {},
    context: test.context,
  });

  assertEquals(test.events.length, 1);
  assertEquals(test.events[0].payload, {
    toolExecutionId: "execution-a",
    toolCallId: "call-a",
    toolId: "terminal",
    toolName: "Terminal",
    channel: "result",
    mode: "replace",
    delta: result,
  });
});

Deno.test("large returned values remain on the asset-backed durable path", async () => {
  const output = { text: "x".repeat(600 * 1024) };
  const test = fixture(() => Promise.resolve(output));

  const outcome = await test.run({
    execution: {
      id: "execution-a",
      namespace: "tenant-a",
      threadId: "thread-a",
      participantId: "agent-a",
      toolCallId: "call-a",
      tool: { id: "terminal", name: "Terminal" },
      status: "running",
      content: [],
      startedAt: "2026-08-13T12:00:00.000Z",
      metadata: {},
      createdAt: "2026-08-13T12:00:00.000Z",
      updatedAt: "2026-08-13T12:00:00.000Z",
    },
    tool: test.tool,
    availableTools: [test.tool],
    arguments: {},
    context: test.context,
  });

  assertEquals(outcome.status, "completed");
  assertEquals(test.events, []);
});

Deno.test("tool result envelopes keep attachment bytes off the live result channel", async () => {
  const attachment = {
    type: "file" as const,
    bytes: new TextEncoder().encode("name,value\nalpha,1\n"),
    mediaType: "text/csv",
    name: "report.csv",
    role: "attachment",
    disposition: "attachment" as const,
  };
  const output = { path: "outputs/report.csv", size: attachment.bytes.length };
  const test = fixture(() => ({
    kind: "copilotz.workflow-tool.result.v1" as const,
    output,
    attachments: [attachment],
  }));

  const outcome = await test.run({
    execution: {
      id: "execution-a",
      namespace: "tenant-a",
      threadId: "thread-a",
      participantId: "agent-a",
      toolCallId: "call-a",
      tool: { id: "terminal", name: "Terminal" },
      status: "running",
      content: [],
      startedAt: "2026-08-13T12:00:00.000Z",
      metadata: {},
      createdAt: "2026-08-13T12:00:00.000Z",
      updatedAt: "2026-08-13T12:00:00.000Z",
    },
    tool: test.tool,
    availableTools: [test.tool],
    arguments: {},
    context: test.context,
  });

  assertEquals(outcome.status, "completed");
  if (outcome.status !== "completed") throw new Error("Expected completion");
  assertEquals(outcome.output, output);
  assertEquals(outcome.attachments, [attachment]);
  assertEquals(test.events.length, 1);
  assertEquals(test.events[0].payload, {
    toolExecutionId: "execution-a",
    toolCallId: "call-a",
    toolId: "terminal",
    toolName: "Terminal",
    channel: "result",
    mode: "replace",
    delta: output,
  });
});

Deno.test("tool asset resolution accepts namespace-qualified canonical refs", async () => {
  let requestedAssetId = "";
  const test = fixture(async (_args, context) => {
    const asset = await context!.resolveAsset!(
      "asset://tenant-a/asset%2Freport",
    );
    assertEquals(asset, {
      bytes: new TextEncoder().encode("report"),
      mime: "text/csv",
    });
    return { imported: true };
  });
  const processorContent = test.context.content as unknown as {
    get(assetId: string): Promise<unknown>;
    resolve(ref: unknown): Promise<unknown>;
  };
  processorContent.get = (assetId) => {
    requestedAssetId = assetId;
    return Promise.resolve({ id: assetId, mediaType: "text/csv" });
  };
  processorContent.resolve = () =>
    Promise.resolve({ bytes: new TextEncoder().encode("report") });

  const outcome = await test.run({
    execution: {
      id: "execution-a",
      namespace: "tenant-a",
      threadId: "thread-a",
      participantId: "agent-a",
      toolCallId: "call-a",
      tool: { id: "terminal", name: "Terminal" },
      status: "running",
      content: [],
      startedAt: "2026-08-13T12:00:00.000Z",
      metadata: {},
      createdAt: "2026-08-13T12:00:00.000Z",
      updatedAt: "2026-08-13T12:00:00.000Z",
    },
    tool: test.tool,
    availableTools: [test.tool],
    arguments: {},
    context: test.context,
  });

  assertEquals(outcome.status, "completed");
  assertEquals(requestedAssetId, "asset/report");
});
