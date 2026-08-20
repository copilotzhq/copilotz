import { assert, assertEquals, assertExists } from "@std/assert";
import {
  type CopilotzPlugin,
  type CopilotzProcessorContext,
  createCopilotz,
  definePlugin,
  defineProcessor,
} from "../../index.ts";
import { createTestDomainContext } from "../../runtime/testing/domain-context.ts";
import {
  projectLlmAttempts,
  projectMessageById,
  projectMessages,
  projectParticipants,
  projectThreadByExternalId,
  projectThreadById,
  projectThreads,
  projectToolExecutionById,
  projectToolExecutions,
} from "../../runtime/testing/projections.ts";
import { loadMessageRecord } from "../../runtime/engine/collection-graph.ts";
import { coreCollectionsPlugin } from "../../plugins/core/plugin.ts";

const NAMESPACE = "v3-root-contract";

function publicReplyPlugin(): CopilotzPlugin {
  const processor = defineProcessor<CopilotzProcessorContext>({
    id: "contract.public-reply",
    on: [{
      eventType: "message.created",
      routing: { senderId: "contract-user" },
    }],
    async handle(event, context) {
      assert(event.durable);
      assertExists(event.subject);
      const source = await loadMessageRecord(context, event.subject.id);
      assertExists(source);
      const content = await context.content.prepare("Hello from v3", {
        operationKey: "reply-content",
      });
      const persisted = await context.content.materialize(content);
      await context.collections.message.create({
        id: "contract-reply",
        threadId: source.threadId,
        senderId: "contract-agent",
        recipientIds: [source.sender.id],
        content: persisted,
      }, { operationKey: "reply-message" });
      await context.content.linkOwner("contract-reply", persisted);
    },
  });
  return definePlugin({
    manifest: {
      id: "contract.public-reply",
      version: "3.0.0",
      provides: { processors: [processor.id] },
    },
    resources: { processors: [processor] },
  });
}

async function collect<T>(stream: ReadableStream<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of stream) values.push(value);
  return values;
}

Deno.test("root createCopilotz runs one causal event scope without queue state", async () => {
  const copilotz = await createCopilotz({
    namespace: NAMESPACE,
    core: false,
    canonicalCore: [coreCollectionsPlugin],
    plugins: [publicReplyPlugin()],
    engine: { retryBaseMs: 0, random: () => 0 },
  });
  try {
    assertEquals(copilotz.role, "embedded");
    assertEquals("engine" in copilotz, false);
    assertEquals("execution" in copilotz, false);
    assertEquals("hypervisor" in copilotz, false);
    assertEquals("transports" in copilotz, false);
    await createTestDomainContext(copilotz, NAMESPACE).features.thread.create({
      id: "contract-thread",
      participants: [
        {
          id: "contract-user",
          externalId: "user-1",
          participantType: "human",
        },
        {
          id: "contract-agent",
          externalId: "support",
          participantType: "agent",
          agentId: "support",
        },
      ],
    });

    const run = await copilotz.run({
      thread: "contract-thread",
      participant: "contract-user",
      recipientIds: ["contract-agent"],
      content: "Hello",
    });
    const observed = collect(run.events);
    await run.done;

    assert(run.eventId.length > 0);
    assert(run.correlationId.length > 0);
    assertEquals("queueId" in run, false);
    assertEquals("status" in run, false);
    assertEquals(
      (await observed).filter((event) => event.type === "message.created")
        .length,
      2,
    );
    const messages = await projectMessages(
      copilotz,
      NAMESPACE,
      "contract-thread",
    );
    assertEquals(messages.length, 2);
    assertEquals(
      (await copilotz.content.resolver.getMany(messages[1].content, {
        namespace: NAMESPACE,
      }))[0].text,
      "Hello from v3",
    );
    const settlement = await copilotz.events.settlement(
      NAMESPACE,
      run.eventId,
    );
    assertEquals(settlement.unsettled, 0);
    assertEquals(settlement.deadLetters, 0);
  } finally {
    await copilotz.shutdown();
  }
});
