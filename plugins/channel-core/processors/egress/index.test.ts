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
          visibility: { kind: "public" },
          recipientIds: ["agent-a"],
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
      visibility: { kind: "public" },
      recipientIds: ["agent-a"],
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

Deno.test("channel egress processor enforces Core envelope visibility", async () => {
  let actionCalls = 0;
  const context = {
    actions: {
      channelEgress: async () => {
        actionCalls += 1;
        return { intents: [] };
      },
    },
    collections: {
      message: {
        get: () => {
          throw new Error("snapshot is authoritative");
        },
      },
      participant: { get: async () => ({ participantType: "agent" }) },
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
  } as never;
  const base = {
    id: "message-a",
    senderId: "agent-a",
    threadId: "thread-a",
    content: [{
      assetId: "asset-a",
      kind: "text",
      role: "body",
      mediaType: "text/plain",
    }],
    metadata: {},
  };
  for (
    const [index, visibility] of [
      { kind: "internal" },
      { kind: "participants", participantIds: ["human-a"] },
    ].entries()
  ) {
    await channelEgressProcessor.handle({
      durable: true,
      id: `event-private-${index}`,
      correlationId: "correlation-a",
      subject: { type: "message", id: "message-a" },
      metadata: { core: { visibility } },
      data: { record: base },
    } as never, context);
  }
  await channelEgressProcessor.handle({
    durable: true,
    id: "event-conflict",
    correlationId: "correlation-a",
    subject: { type: "message", id: "message-a" },
    metadata: { core: { visibility: { kind: "internal" } } },
    data: { record: { ...base, visibility: { kind: "public" } } },
  } as never, context);
  assertEquals(actionCalls, 0);
  await channelEgressProcessor.handle({
    durable: true,
    id: "event-default-public",
    correlationId: "correlation-a",
    subject: { type: "message", id: "message-a" },
    metadata: { core: { threadId: "thread-a" } },
    data: { record: base },
  } as never, context);
  assertEquals(actionCalls, 1);
});

Deno.test("channel egress processor preserves public envelope visibility in the Action snapshot", async () => {
  let actionInput: unknown;
  await channelEgressProcessor.handle({
    durable: true,
    id: "event-public",
    correlationId: "correlation-a",
    subject: { type: "message", id: "message-a" },
    metadata: { core: { visibility: { kind: "public" } } },
    data: {
      record: {
        id: "message-a",
        senderId: "agent-a",
        threadId: "thread-a",
        content: [{
          assetId: "asset-a",
          kind: "text",
          role: "body",
          mediaType: "text/plain",
        }],
        metadata: {},
      },
    },
  } as never, {
    actions: {
      channelEgress: async (input: unknown) => {
        actionInput = input;
        return { intents: [] };
      },
    },
    collections: {
      message: {
        get: () => {
          throw new Error("processor must use snapshot");
        },
      },
      participant: { get: async () => ({ participantType: "agent" }) },
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
  } as never);
  assertEquals(
    (actionInput as { message: { visibility: unknown } }).message.visibility,
    {
      kind: "public",
    },
  );
});
