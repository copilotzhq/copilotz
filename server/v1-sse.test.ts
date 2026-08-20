import { assert, assertEquals } from "@std/assert";

import { createCopilotz } from "../runtime/application/index.ts";
import { coreCollectionsPlugin } from "../plugins/core/plugin.ts";
import type { AttachmentStreamOutput } from "../runtime/attachments/index.ts";
import { createEphemeralEvent } from "../runtime/events/index.ts";
import { createV1SseProjector } from "./v1-sse.ts";
import { createTestDomainContext } from "../runtime/testing/domain-context.ts";

const NAMESPACE = "tenant-a";

Deno.test("v1 SSE projector maps live vocabulary and hydrates canonical public messages", async () => {
  const application = await createCopilotz({
    namespace: NAMESPACE,
    databaseSchema: "copilotz_v1_sse",
    core: false,
    canonicalCore: [coreCollectionsPlugin],
  });
  try {
    const domain = createTestDomainContext(application, NAMESPACE);
    await domain.features.thread.create({
      id: "thread-a",
      participants: [{
        id: "agent-a",
        externalId: "support",
        participantType: "agent",
        agentId: "support",
        name: "Support",
      }],
    });
    const content = await application.content.preparer.prepare("Final answer", {
      namespace: NAMESPACE,
      idempotencyKey: "v1-message-content",
    });
    await domain.features.threadMessage.create({
      id: "message-a",
      threadId: "thread-a",
      sender: {
        id: "agent-a",
        externalId: "support",
        participantType: "agent",
        agentId: "support",
        name: "Support",
      },
      content,
      metadata: { public: true },
    });
    const project = createV1SseProjector(application);
    const request = new Request("https://example.test/channels/web");
    const text = await project(
      createEphemeralEvent({
        type: "text.delta",
        namespace: NAMESPACE,
        threadId: "thread-a",
        payload: {
          text: "Final ",
          agent: { id: "support", name: "Support" },
        },
        correlationId: "correlation-a",
      }),
      request,
    ) as Record<string, unknown>;
    assertEquals(text.type, "TOKEN");
    assertEquals(text.payload, {
      threadId: "thread-a",
      agent: { id: "support", name: "Support" },
      token: "Final ",
      isComplete: false,
      isReasoning: false,
    });

    const reasoning = await project(
      createEphemeralEvent({
        type: "reasoning.delta",
        namespace: NAMESPACE,
        threadId: "thread-a",
        payload: { text: "Think" },
        correlationId: "correlation-a",
      }),
      request,
    ) as Record<string, unknown>;
    assertEquals(
      (reasoning.payload as Record<string, unknown>).isReasoning,
      true,
    );

    const toolOutput = await project(
      createEphemeralEvent({
        type: "tool_output.delta",
        namespace: NAMESPACE,
        threadId: "thread-a",
        payload: {
          toolExecutionId: "execution-a",
          toolCallId: "call-a",
          toolId: "terminal",
          channel: "stdout",
          mode: "append",
          delta: "hello\n",
        },
        correlationId: "correlation-a",
        streamId: "execution-a",
        sequence: 0,
      }),
      request,
    ) as Record<string, unknown>;
    assertEquals(toolOutput.type, "TOOL_OUTPUT_DELTA");
    assertEquals(toolOutput.payload, {
      threadId: "thread-a",
      toolExecutionId: "execution-a",
      toolCallId: "call-a",
      toolId: "terminal",
      channel: "stdout",
      mode: "append",
      delta: "hello\n",
    });

    const createdEvent = (await application.events.list({
      namespace: NAMESPACE,
      threadId: "thread-a",
      limit: 100,
    })).find((event) => event.subject?.id === "message-a");
    assert(createdEvent);
    const message = await project(createdEvent, request) as Record<
      string,
      unknown
    >;
    assertEquals(message.type, "NEW_MESSAGE");
    assertEquals(message.payload, {
      id: "message-a",
      content: "Final answer",
      sender: {
        id: "agent-a",
        externalId: "support",
        type: "agent",
        name: "Support",
      },
      targetQueue: [],
      thread: { id: "thread-a" },
      metadata: { public: true },
      createdAt: (message.payload as { createdAt: string }).createdAt,
    });
  } finally {
    await application.shutdown();
  }
});

Deno.test("v1 SSE projector leaves media as references and never serializes a byte stream", async () => {
  const application = await createCopilotz({
    namespace: NAMESPACE,
    databaseSchema: "copilotz_v1_sse_media",
    core: false,
    canonicalCore: [coreCollectionsPlugin],
  });
  try {
    const project = createV1SseProjector(application, {
      assetHref: ({ assetId }) => `/v3/assets/${assetId}`,
      unknown: "omit",
    });
    const output: AttachmentStreamOutput = Object.freeze({
      type: "stream.output",
      streamId: "audio-a",
      participant: Object.freeze({
        id: "agent-a",
        externalId: "support",
        type: "agent",
      }),
      mediaType: "audio/pcm;rate=24000",
      correlationId: "correlation-a",
      metadata: Object.freeze({}),
      payload: new ReadableStream<Uint8Array>(),
    });
    const projected = await project(
      output,
      new Request("https://example.test/channels/web"),
    ) as Record<string, unknown>;
    assertEquals(projected.type, "stream.output");
    assertEquals("payload" in projected, false);
    assertEquals(
      await project(
        createEphemeralEvent({
          type: "custom.cursor",
          namespace: NAMESPACE,
          payload: { x: 1 },
          correlationId: "correlation-a",
        }),
        new Request("https://example.test/channels/web"),
      ),
      null,
    );
  } finally {
    await application.shutdown();
  }
});

Deno.test("v1 SSE compatibility projection is factory-first and runtime-neutral", async () => {
  const source = await Deno.readTextFile(new URL("v1-sse.ts", import.meta.url));
  assert(!/\bDeno\./.test(source));
  assert(!/from\s+["']node:/.test(source));
  assert(!/^\s*(?:export\s+)?class\s/m.test(source));
});
