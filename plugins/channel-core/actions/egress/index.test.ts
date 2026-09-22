import { assertEquals } from "@std/assert";
import { CHANNEL_EGRESS_ACTION_ID, channelEgressAction } from "./index.ts";

Deno.test("channel egress action has the canonical ID", () => {
  assertEquals(channelEgressAction.id, CHANNEL_EGRESS_ACTION_ID);
});

Deno.test("channel egress action uses a supplied message snapshot", async () => {
  const output = await channelEgressAction.execute(
    {
      messageId: "message-a",
      message: {
        id: "message-a",
        senderId: "agent-a",
        threadId: "thread-a",
        content: [{
          assetId: "asset-a",
          kind: "text",
          role: "body",
          mediaType: "text/plain; charset=utf-8",
          value: "Resolved text is not part of the delivery intent.",
        }],
        metadata: { source: "event" },
      },
    } as never,
    {
      collections: {
        message: {
          get: () => {
            throw new Error("The supplied snapshot must avoid this read.");
          },
        },
        participant: {
          get: async () => ({
            id: "agent-a",
            participantType: "agent",
            externalId: "agent-external-a",
          }),
        },
        channelBinding: {
          queries: {
            byThreadId: async () => [{
              id: "binding-a",
              channelId: "support",
              externalThreadId: "external-thread-a",
              route: { conversation: "conversation-a" },
              metadata: { source: "binding" },
            }],
          },
        },
      },
      resources: { channels: { support: { egress: "external" } } },
    } as never,
  );

  assertEquals(output.intents.length, 1);
  assertEquals(output.intents[0].content, [{
    assetId: "asset-a",
    kind: "text",
    role: "body",
    mediaType: "text/plain; charset=utf-8",
  }]);
  assertEquals(output.intents[0].metadata, {
    binding: { source: "binding" },
    message: { source: "event" },
  });
});

Deno.test("channel egress action fetches a message for ID-only callers", async () => {
  let messageReads = 0;
  const output = await channelEgressAction.execute(
    { messageId: "message-a" },
    {
      collections: {
        message: {
          get: async () => {
            messageReads += 1;
            return {
              id: "message-a",
              senderId: "agent-a",
              threadId: "thread-a",
              content: [],
              metadata: {},
            };
          },
        },
        participant: {
          get: async () => ({
            id: "agent-a",
            participantType: "agent",
            externalId: "agent-external-a",
          }),
        },
        channelBinding: { queries: { byThreadId: async () => [] } },
      },
      resources: { channels: {} },
    } as never,
  );

  assertEquals(messageReads, 1);
  assertEquals(output, { intents: [] });
});

Deno.test("channel egress keeps public narration and media with stable delivery keys", async () => {
  const message = {
    id: "message-public",
    senderId: "agent-a",
    threadId: "thread-a",
    visibility: { kind: "public" },
    recipientIds: [],
    content: [
      {
        assetId: "text-body",
        kind: "text",
        role: "body",
        mediaType: "text/plain",
      },
      {
        assetId: "json-body",
        kind: "json",
        role: "body",
        mediaType: "application/json",
      },
      {
        assetId: "image-attachment",
        kind: "image",
        role: "attachment",
        mediaType: "image/png",
      },
      {
        assetId: "audio-body",
        kind: "audio",
        role: "body",
        mediaType: "audio/mpeg",
      },
      {
        assetId: "private-reasoning",
        kind: "text",
        role: "reasoning",
        mediaType: "text/plain",
      },
      {
        assetId: "tool-output",
        kind: "json",
        role: "tool.output",
        mediaType: "application/json",
      },
      {
        assetId: "system-text",
        kind: "text",
        role: "system",
        mediaType: "text/plain",
      },
    ],
    metadata: {
      llmToolCalls: [{ id: "call-a", name: "buttons" }],
      actionPayload: { buttons: [{ id: "yes", label: "Yes" }] },
    },
  } as const;
  const context = {
    collections: {
      message: { get: async () => message },
      participant: {
        get: async () => ({
          id: "agent-a",
          participantType: "agent",
          externalId: "agent-external-a",
        }),
      },
      channelBinding: {
        queries: {
          byThreadId: async () => [{
            id: "binding-a",
            channelId: "support",
            externalThreadId: "external-thread-a",
            route: { conversation: "conversation-a" },
            metadata: { source: "binding" },
          }],
        },
      },
    },
    resources: { channels: { support: { egress: "external" } } },
  } as never;

  const first = await channelEgressAction.execute(
    { messageId: message.id },
    context,
  );
  const second = await channelEgressAction.execute(
    { messageId: message.id },
    context,
  );
  assertEquals(first.intents.length, 1);
  assertEquals(first.intents[0].content, [
    {
      assetId: "text-body",
      kind: "text",
      role: "body",
      mediaType: "text/plain",
    },
    {
      assetId: "json-body",
      kind: "json",
      role: "body",
      mediaType: "application/json",
    },
    {
      assetId: "image-attachment",
      kind: "image",
      role: "attachment",
      mediaType: "image/png",
    },
    {
      assetId: "audio-body",
      kind: "audio",
      role: "body",
      mediaType: "audio/mpeg",
    },
  ]);
  assertEquals(first.intents[0].metadata, {
    binding: { source: "binding" },
    message: message.metadata,
  });
  assertEquals(
    first.intents[0].deliveryKey,
    second.intents[0].deliveryKey,
  );
});

Deno.test("channel egress action suppresses private messages before participant or binding reads", async () => {
  let participantReads = 0;
  let bindingReads = 0;
  const context = {
    collections: {
      message: { get: async () => ({}) },
      participant: {
        get: async () => {
          participantReads += 1;
          return { id: "agent-a", participantType: "agent" };
        },
      },
      channelBinding: {
        queries: {
          byThreadId: async () => {
            bindingReads += 1;
            return [];
          },
        },
      },
    },
    resources: { channels: {} },
  } as never;
  const output = await channelEgressAction.execute({
    messageId: "message-private",
    message: {
      id: "message-private",
      senderId: "agent-a",
      threadId: "thread-a",
      visibility: { kind: "internal" },
      historyScopeId: "agent-turn-a",
      content: [{
        assetId: "private-body",
        kind: "text",
        role: "body",
        mediaType: "text/plain",
      }],
      metadata: { copilotzAsk: { mode: "private" } },
    },
  }, context);
  assertEquals(output, { intents: [] });
  assertEquals(participantReads, 0);
  assertEquals(bindingReads, 0);
});
