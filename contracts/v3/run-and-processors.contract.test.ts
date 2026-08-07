import { assert, assertEquals, assertExists } from "@std/assert";

import { createCopilotz } from "@/index.ts";
import { createMessageHandlers } from "@/server/index.ts";
import type {
  Event,
  MessagePayload,
  ProcessorDeps,
  StreamEvent,
} from "@/index.ts";

const agent = {
  id: "contract-agent",
  name: "contract-agent",
  role: "assistant",
  instructions: "Characterization fixture.",
  llmOptions: { provider: "openai", model: "contract-model" },
} as const;

function senderType(event: Event): string {
  const payload = event.payload as MessagePayload;
  return payload.sender?.type ?? "unknown";
}

async function drain(events: AsyncIterable<StreamEvent>) {
  const drained: StreamEvent[] = [];
  for await (const event of events) drained.push(event);
  return drained;
}

Deno.test("A06/A08/A14/A16 public run preserves processor claim and stream order", async () => {
  const observations: string[] = [];
  let skippedCalls = 0;

  const copilotz = await createCopilotz({
    namespace: "v3-contracts",
    dbConfig: { url: ":memory:" },
    agents: [agent],
    processors: [{
      id: "contract-observer",
      eventType: "NEW_MESSAGE",
      priority: 100,
      shouldProcess: () => true,
      process: (event: Event) => {
        observations.push(`observer:${event.type}:${senderType(event)}`);
      },
    }, {
      id: "contract-responder",
      eventType: "NEW_MESSAGE",
      priority: 50,
      shouldProcess: () => true,
      process: async (event: Event, deps: ProcessorDeps) => {
        const type = senderType(event);
        observations.push(`responder:${event.type}:${type}`);

        if (type === "user") {
          deps.emitToStream({
            id: crypto.randomUUID(),
            threadId: String(event.threadId),
            type: "ACTION",
            payload: { kind: "contract.marker" },
          } as unknown as Event);

          await deps.db.ops.mutate.messages.create(
            {
              threadId: String(event.threadId),
              senderId: agent.id,
              senderType: "agent",
              content: "characterized answer",
              toolCalls: null,
              metadata: { visibility: "public" },
            },
            deps.context.namespace,
            {
              traceId: typeof event.traceId === "string"
                ? event.traceId
                : undefined,
              causationId: typeof event.id === "string" ? event.id : undefined,
              runGeneration: typeof event.runGeneration === "number"
                ? event.runGeneration
                : undefined,
              priority: typeof event.priority === "number"
                ? event.priority
                : undefined,
              status: "pending",
              eventPayload: {
                content: "characterized answer",
                sender: {
                  id: agent.id,
                  name: agent.name,
                  type: "agent",
                },
                thread: { id: String(event.threadId) },
                metadata: { visibility: "public" },
              },
            },
          );
        }

        return { producedEvents: [] };
      },
    }, {
      id: "contract-skipped-after-claim",
      eventType: "NEW_MESSAGE",
      priority: 0,
      shouldProcess: () => true,
      process: () => {
        skippedCalls += 1;
      },
    }],
  });

  try {
    const handle = await copilotz.run({
      content: "characterized input",
      sender: {
        type: "user",
        externalId: "contract-user",
        name: "Contract User",
      },
      thread: {
        externalId: "v3-run-contract",
        participants: [agent.id],
      },
    });

    assertEquals(handle.status, "queued");
    assert(handle.queueId.length > 0);
    assert(handle.threadId.length > 0);
    assertEquals(typeof handle.cancel, "function");

    const streamedPromise = drain(handle.events);
    await handle.done;
    const streamed = await streamedPromise;

    assertEquals(observations, [
      "observer:message.created:user",
      "responder:message.created:user",
      "observer:message.created:agent",
      "responder:message.created:agent",
    ]);
    assertEquals(skippedCalls, 0);

    const userEventIndex = streamed.findIndex((event) =>
      event.type === "message.created" &&
      (event.payload as MessagePayload).sender?.type === "user"
    );
    const markerIndex = streamed.findIndex((event) => event.type === "ACTION");
    const agentEventIndex = streamed.findIndex((event) =>
      event.type === "message.created" &&
      (event.payload as MessagePayload).sender?.type === "agent"
    );

    assert(userEventIndex >= 0, "user message event was not streamed");
    assert(markerIndex > userEventIndex, "processor ran before event emission");
    assert(
      agentEventIndex > markerIndex,
      "caused agent message was not streamed after the processor marker",
    );

    const messages = await createMessageHandlers(copilotz).listFromGraph(
      handle.threadId,
    );
    assertEquals(
      messages.map((message) => [message.senderType, message.content]),
      [
        ["user", "characterized input"],
        ["agent", "characterized answer"],
      ],
    );

    const queueItem = await copilotz.ops.getQueueItemById(handle.queueId);
    assertExists(queueItem);
    assertEquals(queueItem.status, "completed");
  } finally {
    await copilotz.shutdown();
  }
});

Deno.test("A07 current cancel closes observation but lets accepted durable work settle", async () => {
  let processorFinished = false;
  const copilotz = await createCopilotz({
    namespace: "v3-cancel-contract",
    dbConfig: { url: ":memory:" },
    agents: [agent],
    processors: [{
      eventType: "NEW_MESSAGE",
      shouldProcess: () => true,
      process: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        processorFinished = true;
        return { producedEvents: [] };
      },
    }],
  });

  try {
    const handle = await copilotz.run({
      content: "cancel observation",
      sender: { type: "user", externalId: "cancel-user" },
    });

    handle.cancel();
    handle.cancel();

    assertEquals(await drain(handle.events), []);
    await handle.done;
    assertEquals(processorFinished, true);

    const queueItem = await copilotz.ops.getQueueItemById(handle.queueId);
    assertExists(queueItem);
    assertEquals(queueItem.status, "completed");
  } finally {
    await copilotz.shutdown();
  }
});
