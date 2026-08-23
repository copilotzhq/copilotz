import { assertEquals } from "@std/assert";

import type { CopilotzEvent } from "@copilotz/copilotz/events";
import type { ProcessorContext } from "@copilotz/copilotz/plugins";
import type { WorkflowTool } from "./types.ts";
import { createWorkflowToolExecutor } from "./executor.ts";
import { createContentPreparer } from "@copilotz/copilotz/content";

function fixture(
  execute: WorkflowTool["execute"],
): Readonly<{
  run: ReturnType<typeof createWorkflowToolExecutor>;
  tool: WorkflowTool;
  context: ProcessorContext;
  sourceEvent: CopilotzEvent;
  chunks: Array<Record<string, unknown>>;
  finalized: () => number;
}> {
  const chunks: Array<Record<string, unknown>> = [];
  let finalized = 0;
  const tool: WorkflowTool = {
    id: "terminal",
    key: "terminal",
    name: "Terminal",
    description: "Test terminal.",
    inputSchema: { type: "object" },
    execute,
  };
  let assetId = 0;
  const preparer = createContentPreparer({
    createId: () => `extracted-${++assetId}`,
  });
  const openStream = () =>
    Promise.resolve({
      id: "stream-a",
      offset() {
        return 0;
      },
      append(input: { bytes: Uint8Array; appendId: string }) {
        const bytes = input.bytes;
        const text = new TextDecoder().decode(bytes);
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          chunks.push(JSON.parse(line) as Record<string, unknown>);
        }
        return Promise.resolve({
          startOffset: 0,
          endOffset: bytes.byteLength,
        });
      },
      close() {
        finalized += 1;
        return Promise.resolve({
          content: [],
          assets: [],
        });
      },
      abort() {
        return Promise.resolve();
      },
      [Symbol.asyncDispose]() {
        return Promise.resolve();
      },
    });
  const sourceEvent: CopilotzEvent = {
    durable: true,
    id: "event-a",
    position: "1",
    schemaVersion: 1,
    type: "copilotz.core.tool.call.invoked",
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
  };
  const context = {
    namespace: "tenant-a",
    operationKey: "delivery-a",
    identity: {
      causationId: sourceEvent.id,
      correlationId: sourceEvent.correlationId,
      deduplicationId: "delivery-a",
    },
    signal: new AbortController().signal,
    resources: {
      agents: {},
      tools: { terminal: tool },
      apis: {},
      mcp: {},
      skills: {},
    },
    adapters: { llm: {} },
    actions: {},
    collections: {},
    content: {
      prepare: (
        input: Parameters<typeof preparer.prepare>[0],
        options: { operationKey: string },
      ) =>
        preparer.prepare(input, {
          namespace: "tenant-a",
          idempotencyKey: options.operationKey,
        }),
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
    now: () => new Date("2026-08-13T12:00:00.000Z"),
    transaction: () => Promise.reject(new Error("Not used by this fixture.")),
  } as unknown as ProcessorContext;
  return Object.freeze({
    run: createWorkflowToolExecutor({ openStream }),
    tool,
    context,
    sourceEvent,
    chunks,
    finalized: () => finalized,
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
      metadata: {},
    },
    tool: test.tool,
    availableTools: [test.tool],
    arguments: {},
    context: test.context,
    sourceEvent: test.sourceEvent,
  });

  assertEquals(outcome.status, "completed");
  assertEquals(test.finalized(), 1);
  assertEquals(test.chunks, [{
    channel: "stdout",
    mode: "append",
    sequence: 0,
    delta: "one",
  }, {
    channel: "stderr",
    mode: "append",
    sequence: 1,
    delta: "two",
  }, {
    channel: "result",
    mode: "replace",
    sequence: 2,
    delta: { stdout: "one", stderr: "two", exitCode: 0 },
  }]);
});

Deno.test("automatic tool output extracts nested data URLs before streaming", async () => {
  const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
  const test = fixture(() => Promise.resolve({ ok: true, imageUrl: dataUrl }));
  const outcome = await test.run({
    execution: {
      id: "execution-a",
      namespace: "tenant-a",
      threadId: "thread-a",
      participantId: "agent-a",
      toolCallId: "call-a",
      tool: { id: "terminal", name: "Terminal" },
      metadata: {},
    },
    tool: test.tool,
    availableTools: [test.tool],
    arguments: {},
    context: test.context,
    sourceEvent: test.sourceEvent,
  });
  assertEquals(outcome.status, "completed");
  if (outcome.status !== "completed") return;
  assertEquals(outcome.extractedAttachments?.assets.length, 1);
  assertEquals(JSON.stringify(outcome.output).includes("base64"), false);
  assertEquals(JSON.stringify(test.chunks).includes("base64"), false);
  assertEquals(test.chunks[0], {
    channel: "result",
    mode: "replace",
    sequence: 0,
    delta: {
      ok: true,
      imageUrl: {
        assetRef: "asset://tenant-a/extracted-1",
        kind: "image",
        mediaType: "image/png",
        byteLength: 8,
      },
    },
  });
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
      metadata: {},
    },
    tool: test.tool,
    availableTools: [test.tool],
    arguments: {},
    context: test.context,
    sourceEvent: test.sourceEvent,
  });

  assertEquals(test.chunks.length, 1);
  assertEquals(test.chunks[0], {
    channel: "result",
    mode: "replace",
    sequence: 0,
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
      metadata: {},
    },
    tool: test.tool,
    availableTools: [test.tool],
    arguments: {},
    context: test.context,
    sourceEvent: test.sourceEvent,
  });

  assertEquals(outcome.status, "completed");
  assertEquals(test.chunks, []);
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
      metadata: {},
    },
    tool: test.tool,
    availableTools: [test.tool],
    arguments: {},
    context: test.context,
    sourceEvent: test.sourceEvent,
  });

  assertEquals(outcome.status, "completed");
  if (outcome.status !== "completed") throw new Error("Expected completion");
  assertEquals(outcome.output, output);
  assertEquals(outcome.attachments, [attachment]);
  assertEquals(test.chunks.length, 1);
  assertEquals(test.chunks[0], {
    channel: "result",
    mode: "replace",
    sequence: 0,
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
      metadata: {},
    },
    tool: test.tool,
    availableTools: [test.tool],
    arguments: {},
    context: test.context,
    sourceEvent: test.sourceEvent,
  });

  assertEquals(outcome.status, "completed");
  assertEquals(requestedAssetId, "asset/report");
});
