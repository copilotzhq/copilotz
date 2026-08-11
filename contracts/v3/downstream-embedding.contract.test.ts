import { assertEquals, assertExists } from "@std/assert";
import { createHypervisor } from "../../dependencies/oxian-hypervisor.ts";
import { createWorker } from "../../dependencies/oxian-worker.ts";

import {
  type CopilotzProcessorContext,
  createCopilotzGateway,
  createCopilotzWorker,
  defineLlmProviderResource,
  definePlugin,
  defineProcessor,
  type LlmProviderResource,
} from "../../index.ts";
import { createTestDatabase } from "../../runtime/testing/ominipg.ts";

const NAMESPACE = "downstream-embedding";

function migratedApplicationPlugin() {
  const provider = defineLlmProviderResource({
    id: "downstream-injected",
    type: "llm",
    factory: () => ({
      endpoint: "https://downstream.invalid/v1/chat",
      headers: () => ({ "content-type": "application/json" }),
      body: (messages) => ({ messages }),
      extractContent: () => null,
    }),
  });
  const processor = defineProcessor<CopilotzProcessorContext>({
    id: "downstream.reply",
    on: ["message.created"],
    delivery: "durable",
    filter: (event) => event.routing?.senderId === "downstream-user",
    async handle(event, context) {
      if (!event.durable) throw new TypeError("Durable delivery required.");
      assertExists(event.subject);
      const source = await context.conversation.getMessage(event.subject.id);
      assertExists(source);
      const content = await context.content.prepare("embedded reply", {
        operationKey: "downstream-reply-content",
      });
      await context.conversation.createMessage({
        id: "downstream-reply",
        threadId: source.threadId,
        sender: {
          id: "downstream-agent",
          externalId: "support",
          participantType: "agent",
          agentId: "support",
        },
        recipientIds: [source.sender.id],
        content,
      }, { operationKey: "downstream-reply-message" });
    },
  });
  return definePlugin({
    manifest: {
      id: "@downstream/application",
      version: "3.0.0",
      provides: {
        agents: ["support"],
        providers: [provider.id],
        processors: [processor.id],
      },
    },
    resources: {
      agents: [{
        id: "support",
        name: "Support",
        role: "Support agent",
        runtimes: {
          text: { type: "llm", provider: provider.id, model: "injected" },
        },
      }],
      providers: [provider],
      processors: [processor],
    },
  });
}

Deno.test("downstream app embeds Copilotz with app-owned database, Hypervisor, and plugin", async () => {
  const database = await createTestDatabase({ url: ":memory:" });
  const transport = {
    type: "in-process",
    config: { topic: `copilotz.downstream.${crypto.randomUUID()}` },
  } as const;
  const hypervisor = createHypervisor({
    transports: [transport],
  });
  const plugin = migratedApplicationPlugin();
  const workerId = "downstream-copilotz";
  const application = await createCopilotzGateway({
    session: database.session,
    namespace: NAMESPACE,
    core: false,
    plugins: [plugin],
    dispatcher: hypervisor,
    target: { workerId },
    engine: {
      retryBaseMs: 0,
      random: () => 0,
    },
  });
  const worker = await createCopilotzWorker({
    session: database.session,
    namespace: NAMESPACE,
    core: false,
    plugins: [plugin],
    id: workerId,
    transport,
    engine: { retryBaseMs: 0, random: () => 0 },
  });
  try {
    await worker.ready;
    assertEquals(application.config.sessionOwnership, "injected");
    assertEquals("engine" in application, false);
    assertEquals("execution" in application, false);
    assertEquals(
      application.plugins.require<LlmProviderResource>(
        "providers",
        "downstream-injected",
      ).id,
      "downstream-injected",
    );
    await application.conversation.createThread({
      id: "downstream-thread",
      namespace: NAMESPACE,
      participants: [
        {
          id: "downstream-user",
          externalId: "user-1",
          participantType: "human",
        },
        {
          id: "downstream-agent",
          externalId: "support",
          participantType: "agent",
          agentId: "support",
        },
      ],
    });
    const run = await application.run({
      thread: "downstream-thread",
      participant: "downstream-user",
      recipientIds: ["downstream-agent"],
      content: "hello",
    });
    await run.done;
    assertEquals(
      (await application.conversation.listMessages(
        NAMESPACE,
        "downstream-thread",
      )).length,
      2,
    );
  } finally {
    await Promise.allSettled([
      application.shutdown(),
      worker.stop(),
    ]);
  }

  let probeWorker: ReturnType<typeof createWorker> | undefined;
  try {
    assertEquals(hypervisor.snapshot().inProcessWorkers, 0);
    assertEquals((await database.query("SELECT 1 AS alive")).rows[0], {
      alive: 1,
    });
    probeWorker = createWorker({
      id: "downstream-probe",
      transport,
      workloads: {
        "downstream.probe.v1": () => ({ metadata: { alive: true } }),
      },
    });
    await probeWorker.ready;
    const probe = await hypervisor.dispatch({
      workload: "downstream.probe.v1",
    });
    assertEquals(await probe.metadata, { alive: true });
    assertEquals((await probe.completed).status, "completed");
  } finally {
    await probeWorker?.stop();
    await probeWorker?.closed;
    await hypervisor.shutdown();
    await database.close();
  }
});
