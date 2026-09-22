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
