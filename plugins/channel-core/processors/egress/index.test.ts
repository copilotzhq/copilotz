import { assertEquals } from "@std/assert";
import { channelEgressProcessor } from "./index.ts";

Deno.test("channel egress processor has its canonical ID", () => {
  assertEquals(channelEgressProcessor.id, "copilotz.channels.external-egress");
});

Deno.test("channel egress processor consumes the triggering message snapshot", async () => {
  let actionInput: unknown;
  await channelEgressProcessor.handle(
    {
      durable: true,
      id: "event-a",
      correlationId: "correlation-a",
      subject: { type: "message", id: "stale-message" },
      payload: { dataRef: { eventBodyId: "body-a" } },
      data: {
        record: {
          id: "message-a",
          senderId: "agent-a",
          threadId: "thread-a",
          content: [{
            assetId: "asset-a",
            kind: "text",
            role: "body",
            mediaType: "text/plain; charset=utf-8",
            value: "The Action input must keep only the ref.",
          }],
          metadata: { source: "agent" },
        },
      },
    } as never,
    {
      actions: {
        channelEgress: async (input: unknown) => {
          actionInput = input;
          return { intents: [] };
        },
      },
      collections: {
        message: {
          get: () => {
            throw new Error("processor must use event.data.record");
          },
        },
        participant: {
          get: async () => ({ participantType: "agent" }),
        },
        channelBinding: {
          queries: {
            byThreadId: async () => [{ channelId: "support" }],
          },
        },
      },
      resources: { channels: { support: { egress: "external" } } },
      adapters: {},
      identity: { settlementScopeId: "scope-a" },
      signal: new AbortController().signal,
    } as never,
  );

  assertEquals(actionInput, {
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
      }],
      metadata: { source: "agent" },
    },
  });
});
