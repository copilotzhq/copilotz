/** @module Verifies the supported downstream application embedding boundary. */
import { message as coreMessage } from "@copilotz/copilotz/core";
import { assertEquals, assertExists } from "@std/assert";
import { createCopilotz } from "../../index.ts";
import {
  definePlugin,
  defineProcessor,
  type ProcessorContext,
} from "@copilotz/copilotz/plugins";
import { defineModel, type LlmAdapter } from "@copilotz/copilotz/llm";
import { createTestDomainContext } from "../../plugins/core/internal/testing/context.ts";
import { projectMessages } from "../../plugins/core/internal/testing/projections.ts";
import { createTestDatabase } from "../../runtime/testing/ominipg.ts";
import { loadMessageRecord } from "@copilotz/copilotz/core";
import { coreCollectionsPlugin } from "../../plugins/core/plugin.ts";
import { createCopilotzApplication } from "../../runtime/application/application.ts";
import { createHypervisor } from "../../dependencies/oxian-hypervisor.ts";
import { createWorker } from "../../dependencies/oxian-worker.ts";

const NAMESPACE = "downstream-embedding";

function migratedApplicationPlugin() {
  const adapter: LlmAdapter = Object.freeze({
    call: () => ({
      frames: new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
      result: Promise.resolve({
        content: "downstream llm is not invoked",
        attempts: [{ status: "completed" as const }],
      }),
    }),
  });
  const model = defineModel({
    adapter: "downstreamInjected",
    model: "injected",
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
          models: { generate: ["injected"] },
        },
      },
      models: { injected: model },
    },
    adapters: { llm: { downstreamInjected: adapter } },
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
  const authoring = await createCopilotzApplication({
    database,
    namespace: NAMESPACE,
    plugins: [coreCollectionsPlugin, plugin],
  });
  await createTestDomainContext(authoring, NAMESPACE).actions.createThread({
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
  await authoring.shutdown();

  const application = await createCopilotz({
    role: "gateway",
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
  const worker = await createCopilotz({
    role: "worker",
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
    assertEquals(Object.keys(application).sort(), [
      "close",
      "fetch",
      "observe",
      "send",
    ]);
    assertEquals(Object.keys(worker).sort(), ["close", "closed", "ready"]);
    const run = await application.send(coreMessage({
      thread: "downstream-thread",
      participant: "downstream-user",
      recipientIds: ["downstream-agent"],
      content: "hello",
    }));
    await run.done;
    const inspector = await createCopilotzApplication({
      database,
      namespace: NAMESPACE,
      plugins: [coreCollectionsPlugin, plugin],
    });
    assertEquals(
      (await projectMessages(inspector, NAMESPACE, "downstream-thread"))
        .length,
      2,
    );
    await inspector.shutdown();
  } finally {
    await Promise.allSettled([
      application.close(),
      worker.close(),
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
