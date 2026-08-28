import { assertEquals, assertExists, assertNotEquals } from "@std/assert";
import type { ActionCaller } from "@copilotz/copilotz/actions";
import { createCopilotzApplication } from "../../runtime/application/application.ts";
import { createTestDomainContext } from "../core/internal/testing/context.ts";
import { createTestDatabase } from "../../runtime/testing/ominipg.ts";
import { deriveWorkflowId } from "../../runtime/events/workflow-id.ts";
import { channelIngress } from "./authoring/channel-ingress/index.ts";
import { channelEgressAction } from "./actions/egress/index.ts";
import type { channelIngressAction } from "./actions/ingress/index.ts";
import { channelsPlugin } from "./plugin.ts";
import { defineChannelResource } from "./authoring/channel-resource/index.ts";
import type {
  ChannelAdapter,
  ChannelDeliveryAttempt,
  ChannelJsonValue,
} from "./internal/contracts.ts";

const NAMESPACE = "channel-workflow";

Deno.test("Channel occurrence becomes one atomic binding graph and external egress reuses a stable intent", async () => {
  const database = await createTestDatabase({ url: ":memory:" });
  const delivered = Promise.withResolvers<ChannelDeliveryAttempt>();
  let receivedInput: ChannelJsonValue | undefined;
  const adapter: ChannelAdapter = Object.freeze({
    accept() {
      throw new Error("Host accept is not used by the worker test.");
    },
    receive(input) {
      receivedInput = input;
      return Object.freeze({
        externalThreadId: "external-thread-1",
        sender: Object.freeze({
          externalId: "fixture:user-1",
          participantType: "human" as const,
          name: "User One",
        }),
        recipients: Object.freeze([
          Object.freeze({
            externalId: "fixture:tool-recipient",
            participantType: "tool" as const,
            name: "Fixture recipient",
          }),
        ]),
        content: Object.freeze([
          "hello",
          Object.freeze({
            type: "file" as const,
            bytes: new Uint8Array([1, 2, 3]),
            mediaType: "application/octet-stream",
            name: "fixture.bin",
          }),
        ]),
        route: Object.freeze({ destination: "external-thread-1" }),
        metadata: Object.freeze({ provider: "fixture" }),
        thread: Object.freeze({
          metadata: Object.freeze({
            system: Object.freeze({
              runtime: Object.freeze({ injected: true }),
            }),
            label: "provider-thread",
          }),
        }),
      });
    },
    deliver(input) {
      delivered.resolve(input);
      return Object.freeze({
        deliveryKey: input.intent.deliveryKey,
        delivered: input.content.length,
        providerIds: Object.freeze(["provider-message-1"]),
      });
    },
  });
  const application = await createCopilotzApplication({
    database,
    namespace: NAMESPACE,
    databaseSchema: "copilotz_channels_workflow",
    plugins: [channelsPlugin],
    resources: {
      channels: {
        fixture: defineChannelResource({
          egress: "external",
          metadata: { deployment: "test" },
        }),
      },
    },
    adapters: { channels: { fixture: adapter } },
  });
  try {
    const occurrence = Object.freeze({
      providerEvent: "event-1",
      mediaBase64: "AQID",
    });
    const handle = await application.send(channelIngress("fixture", {
      id: "event-1",
      input: occurrence,
    }));
    await handle.done;
    assertEquals(receivedInput, occurrence);
    assertEquals(
      (await application.events.list({ namespace: NAMESPACE })).filter(
        (event) => event.type.startsWith(`${channelEgressAction.id}.`),
      ).length,
      0,
    );

    const context = createTestDomainContext(application, NAMESPACE);
    const [binding] = await context.collections.channelBinding.queries
      .byChannelThread({
        channelId: "fixture",
        externalThreadId: "external-thread-1",
      });
    assertExists(binding);
    assertEquals(binding.channelId, "fixture");
    assertEquals(binding.route, { destination: "external-thread-1" });
    assertEquals(binding.metadata, {
      resource: { deployment: "test" },
      provider: { provider: "fixture" },
    });
    assertEquals("correlationId" in binding, false);
    assertEquals("egressChannelId" in binding, false);

    const thread = await context.collections.thread.get({
      id: String(binding.threadId),
    });
    assertExists(thread);
    const threadMetadata = thread.metadata as Record<string, unknown>;
    const system = threadMetadata.system as Record<string, unknown>;
    assertEquals(system.runtime, {});
    assertEquals(
      (system.channels as Record<string, unknown>).fixture,
      {
        bindingId: binding.id,
        externalThreadId: "external-thread-1",
        metadata: {
          system: { runtime: { injected: true } },
          label: "provider-thread",
        },
      },
    );
    const messages = await context.collections.message.queries.byThreadId({
      threadId: thread.id,
    });
    assertEquals(messages.length, 1);
    assertEquals(messages[0].id, binding.inboundMessageId);
    const inboundCreated = (await application.events.list({
      namespace: NAMESPACE,
    })).find((event) =>
      event.type === "message.created" && event.subject?.id === messages[0].id
    );
    assertExists(inboundCreated);
    assertEquals(inboundCreated.visibility, {
      kind: "participants",
      participantIds: [
        String(messages[0].senderId),
        ...(messages[0].recipientIds as readonly string[]),
      ],
    });
    const inbound = await context.content.resolveMany(
      messages[0].content as never,
    );
    assertEquals(inbound[0].text, "hello");
    assertEquals(inbound[1].bytes, new Uint8Array([1, 2, 3]));

    const agent = await context.collections.participant.create({
      id: "fixture-agent-participant",
      externalId: "fixture-agent",
      participantType: "agent",
      agentId: "fixture-agent",
      name: "Fixture Agent",
    }, { operationKey: "fixture-agent" });
    await context.collections.thread.commands.addParticipant({
      id: thread.id,
      participantId: agent.id,
    }, { operationKey: "fixture-agent-thread", threadId: thread.id });
    const prepared = await context.content.prepare("outbound", {
      operationKey: "fixture-outbound-content",
    });
    await context.collections.message.create({
      id: "fixture-agent-message",
      threadId: thread.id,
      senderId: agent.id,
      recipientIds: [],
      content: prepared,
      metadata: {},
    }, {
      operationKey: "fixture-agent-message",
      threadId: thread.id,
      routing: { senderId: agent.id, recipientIds: [] },
      visibility: { kind: "public" },
    });
    const attempt = await Promise.race([
      delivered.promise,
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error("Channel delivery timed out.")),
          2_000,
        )
      ),
    ]);
    assertEquals(attempt.intent.channelId, "fixture");
    assertEquals(attempt.intent.bindingId, binding.id);
    assertEquals(
      attempt.intent.deliveryKey,
      await deriveWorkflowId(
        "channel-delivery",
        JSON.stringify([
          "copilotz.channels.v1",
          binding.id,
          "fixture-agent-message",
        ]),
      ),
    );
    assertEquals(attempt.content[0].text, "outbound");
  } finally {
    await application.shutdown();
    await database.close();
  }
});

Deno.test("declared thread participants are durable members, not message recipients", async () => {
  const database = await createTestDatabase({ url: ":memory:" });
  const north = Object.freeze({
    externalId: "north",
    participantType: "human" as const,
    name: "North",
  });
  const south = Object.freeze({
    externalId: "south",
    participantType: "human" as const,
    name: "South",
  });
  const east = Object.freeze({
    externalId: "east",
    participantType: "human" as const,
    name: "East",
  });
  const west = Object.freeze({
    externalId: "west",
    participantType: "human" as const,
    name: "West",
  });
  const adapter: ChannelAdapter = Object.freeze({
    accept() {
      throw new Error("Host accept is not used by the worker test.");
    },
    receive() {
      return Object.freeze({
        externalThreadId: "declared-members",
        sender: Object.freeze({
          externalId: "user",
          participantType: "human" as const,
          name: "User",
        }),
        recipients: Object.freeze([north]),
        content: "hello north",
        thread: Object.freeze({
          participants: Object.freeze([south, east, west]),
        }),
      });
    },
  });
  const application = await createCopilotzApplication({
    database,
    namespace: NAMESPACE,
    databaseSchema: "copilotz_channels_declared_members",
    plugins: [channelsPlugin],
    resources: {
      channels: {
        fixture: defineChannelResource({ egress: "request-observation" }),
      },
    },
    adapters: { channels: { fixture: adapter } },
  });
  try {
    const handle = await application.send(channelIngress("fixture", {
      id: "declared-members-message",
      input: {},
    }));
    await handle.done;

    const context = createTestDomainContext(application, NAMESPACE);
    const [binding] = await context.collections.channelBinding.queries
      .byChannelThread({
        channelId: "fixture",
        externalThreadId: "declared-members",
      });
    assertExists(binding);
    const thread = await context.collections.thread.get({
      id: String(binding.threadId),
    });
    assertExists(thread);
    const members = await Promise.all(
      (thread.participantIds as readonly string[]).map((id) =>
        context.collections.participant.get({ id })
      ),
    );
    assertEquals(
      members.map((member) => member?.name).sort(),
      ["East", "North", "South", "User", "West"],
    );

    const [message] = await context.collections.message.queries.byThreadId({
      threadId: thread.id,
    });
    assertExists(message);
    const [northRecipient] = await Promise.all(
      (message.recipientIds as readonly string[]).map((id) =>
        context.collections.participant.get({ id })
      ),
    );
    assertExists(northRecipient);
    assertEquals(northRecipient?.name, "North");
    assertEquals(message.recipientIds, [northRecipient.id]);
    const created = (await application.events.list({ namespace: NAMESPACE }))
      .find((event) =>
        event.type === "message.created" && event.subject?.id === message.id
      );
    assertExists(created);
    assertEquals(created.routing, {
      senderId: String(message.senderId),
      recipientIds: [northRecipient.id],
    });
  } finally {
    await application.shutdown();
    await database.close();
  }
});

Deno.test("concurrent same-thread occurrences re-plan graph writes without repeating receive", async () => {
  const database = await createTestDatabase({ url: ":memory:" });
  const gate = Promise.withResolvers<void>();
  let receives = 0;
  const adapter: ChannelAdapter = Object.freeze({
    accept() {
      throw new Error("Host accept is not used by the worker test.");
    },
    async receive(input, context) {
      receives += 1;
      if (receives === 2) gate.resolve();
      if (receives <= 2) await gate.promise;
      const data = input as Record<string, ChannelJsonValue>;
      const index = Number(data.index);
      return Object.freeze({
        externalThreadId: typeof data.thread === "string"
          ? data.thread
          : "shared-thread",
        sender: Object.freeze({
          externalId: typeof data.sender === "string"
            ? data.sender
            : "raw-user",
          participantType: "human" as const,
        }),
        recipients: Object.freeze([
          Object.freeze({
            externalId: typeof data.recipient === "string"
              ? data.recipient
              : "sink",
            participantType: "tool" as const,
          }),
        ]),
        content: `message-${index}`,
        route: Object.freeze({ destination: context.channelId }),
        visibility: "participants" as const,
      });
    },
  });
  const channel = defineChannelResource({ egress: "request-observation" });
  const application = await createCopilotzApplication({
    database,
    namespace: NAMESPACE,
    databaseSchema: "copilotz_channels_concurrent",
    plugins: [channelsPlugin],
    resources: {
      channels: {
        fixture: channel,
        other: channel,
        "a:b": channel,
        a: channel,
      },
    },
    adapters: {
      channels: {
        fixture: adapter,
        other: adapter,
        "a:b": adapter,
        a: adapter,
      },
    },
  });
  try {
    const context = createTestDomainContext(application, NAMESPACE);
    const invoke = context.actions.channelIngress as ActionCaller<
      typeof channelIngressAction
    >;
    const [first, second] = await Promise.all([
      invoke({ channelId: "fixture", id: "one", input: { index: 1 } }, {
        operationKey: "concurrent-one",
      }),
      invoke({ channelId: "fixture", id: "two", input: { index: 2 } }, {
        operationKey: "concurrent-two",
      }),
    ]);
    assertEquals(first.bindingId, second.bindingId);
    assertEquals(first.threadId, second.threadId);
    assertEquals(receives, 2);
    const messages = await context.collections.message.queries.byThreadId({
      threadId: first.threadId,
    });
    assertEquals(
      messages.map((message) => message.id).sort(),
      [first.messageId, second.messageId].sort(),
    );
    const durableEvents = await application.events.list({
      namespace: NAMESPACE,
    });
    for (const message of messages) {
      const created = durableEvents.find((event) =>
        event.type === "message.created" && event.subject?.id === message.id
      );
      assertExists(created);
      assertEquals(created.visibility, {
        kind: "participants",
        participantIds: [
          String(message.senderId),
          ...(message.recipientIds as readonly string[]),
        ],
      });
    }
    const thread = await context.collections.thread.get({ id: first.threadId });
    assertExists(thread);
    const participants = await Promise.all(
      (thread.participantIds as readonly string[]).map((id) =>
        context.collections.participant.get({ id })
      ),
    );
    assertEquals(
      participants.map((participant) => participant?.externalId).sort(),
      [
        'channel:["copilotz.channels.v1","fixture","raw-user"]',
        'channel:["copilotz.channels.v1","fixture","sink"]',
      ].sort(),
    );

    const other = await invoke({
      channelId: "other",
      id: "three",
      input: { index: 3 },
    }, { operationKey: "cross-channel-three" });
    assertEquals(receives, 3);
    const otherThread = await context.collections.thread.get({
      id: other.threadId,
    });
    assertExists(otherThread);
    const otherParticipants = await Promise.all(
      (otherThread.participantIds as readonly string[]).map((id) =>
        context.collections.participant.get({ id })
      ),
    );
    assertEquals(
      otherParticipants.map((participant) => participant?.externalId).sort(),
      [
        'channel:["copilotz.channels.v1","other","raw-user"]',
        'channel:["copilotz.channels.v1","other","sink"]',
      ].sort(),
    );

    const collisionOneEnvelope = channelIngress("a:b", {
      id: "c",
      input: { index: 4 },
    });
    const collisionTwoEnvelope = channelIngress("a", {
      id: "b:c",
      input: { index: 5 },
    });
    assertNotEquals(
      collisionOneEnvelope.correlationId,
      collisionTwoEnvelope.correlationId,
    );
    assertNotEquals(
      collisionOneEnvelope.deduplicationId,
      collisionTwoEnvelope.deduplicationId,
    );

    const collisionOne = await invoke({
      channelId: "a:b",
      id: "c",
      input: {
        index: 4,
        thread: "c",
        sender: "user:c",
        recipient: "sink:c",
      },
    }, { operationKey: "delimiter-one" });
    const collisionTwo = await invoke({
      channelId: "a",
      id: "b:c",
      input: {
        index: 5,
        thread: "b:c",
        sender: "b:user:c",
        recipient: "b:sink:c",
      },
    }, { operationKey: "delimiter-two" });
    assertNotEquals(collisionOne.bindingId, collisionTwo.bindingId);
    assertNotEquals(collisionOne.threadId, collisionTwo.threadId);
    assertNotEquals(collisionOne.messageId, collisionTwo.messageId);
    assertNotEquals(
      await deriveWorkflowId(
        "channel-delivery",
        JSON.stringify(["copilotz.channels.v1", "a:b", "c"]),
      ),
      await deriveWorkflowId(
        "channel-delivery",
        JSON.stringify(["copilotz.channels.v1", "a", "b:c"]),
      ),
    );
    const collisionThreads = await Promise.all([
      context.collections.thread.get({ id: collisionOne.threadId }),
      context.collections.thread.get({ id: collisionTwo.threadId }),
    ]);
    const collisionParticipantIds = collisionThreads.flatMap((record) =>
      Array.isArray(record?.participantIds)
        ? record.participantIds.map(String)
        : []
    );
    assertEquals(new Set(collisionParticipantIds).size, 4);
  } finally {
    await application.shutdown();
    await database.close();
  }
});
