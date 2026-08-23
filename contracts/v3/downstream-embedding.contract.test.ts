import { message as coreMessage } from "@copilotz/copilotz/core";
import { assertEquals, assertExists } from "@std/assert";
import {
  createCopilotzGateway,
  createCopilotzWorker,
  defineLlmProviderResource,
  definePlugin,
  defineProcessor,
  type ProcessorContext,
} from "../../index.ts";
import { createTestDomainContext } from "../../runtime/testing/domain-context.ts";
import { projectMessages } from "../../runtime/testing/projections.ts";
import { createTestDatabase } from "../../runtime/testing/ominipg.ts";
import { loadMessageRecord } from "../../runtime/engine/collection-graph.ts";
import { coreCollectionsPlugin } from "../../plugins/core/plugin.ts";
import { createHypervisor } from "../../dependencies/oxian-hypervisor.ts";
import { createWorker } from "../../dependencies/oxian-worker.ts";

const NAMESPACE = "downstream-embedding";

function migratedApplicationPlugin() {
  const provider = defineLlmProviderResource({
    id: "downstream-injected",
    type: "llm",
    generate: () => {
      throw new Error("downstream llm is not invoked");
    },
  });
  const processor = defineProcessor<ProcessorContext>({
    id: "downstream.reply",
    on: [{
      eventType: "message.created",
      routing: { senderId: "downstream-user" },
    }],
    async handle(event, context) {
      if (!event.durable) throw new TypeError("Durable delivery required.");
      assertExists(event.subject);
      const source = await loadMessageRecord(context, event.subject.id);
      assertExists(source);
      const content = await context.content.prepare("embedded reply", {
        operationKey: "downstream-reply-content",
      });
      await context.collections.message.create({
        id: "downstream-reply",
        threadId: source.threadId,
        senderId: "downstream-agent",
        recipientIds: [source.sender.id],
        content,
      }, { operationKey: "downstream-reply-message" });
    },
  });
  return definePlugin({
    id: "@downstream/application",
    version: "3.0.0",
    resources: {
      agents: {
        support: {
          id: "support",
          name: "Support",
          role: "Support agent",
          runtime: { provider: provider.id, model: "injected" },
        },
      },
    },
    adapters: { llm: { downstreamInjected: provider } },
    processors: { reply: processor },
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
    database,
    namespace: NAMESPACE,
    plugins: [coreCollectionsPlugin, plugin],
    dispatcher: hypervisor,
    target: { workerId },
    engine: {
      retryBaseMs: 0,
      random: () => 0,
    },
  });
  const worker = await createCopilotzWorker({
    database,
    namespace: NAMESPACE,
    plugins: [coreCollectionsPlugin, plugin],
    id: workerId,
    transport,
    capacity: 8,
    engine: { retryBaseMs: 0, random: () => 0 },
  });
  try {
    await worker.ready;
    assertEquals(application.config.databaseOwnership, "injected");
    assertEquals("engine" in application, false);
    assertEquals("execution" in application, false);
    assertEquals(
      (application.plugins.adapters.llm.downstreamInjected as {
        id: string;
      }).id,
      "downstream-injected",
    );
    await createTestDomainContext(application, NAMESPACE).actions.createThread(
      {
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
      },
    );
    const run = await application.send(coreMessage({
      thread: "downstream-thread",
      participant: "downstream-user",
      recipientIds: ["downstream-agent"],
      content: "hello",
    }));
    await run.done;
    assertEquals(
      (await projectMessages(application, NAMESPACE, "downstream-thread"))
        .length,
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
