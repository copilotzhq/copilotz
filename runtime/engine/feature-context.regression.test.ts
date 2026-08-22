import { assertEquals, assertExists } from "@std/assert";
import {
  createPluginRegistry,
  definePlugin,
  defineProcessor,
} from "../plugins/index.ts";
import { createTestDomainContext } from "../../runtime/testing/domain-context.ts";
import { waitForTestDelivery } from "../../runtime/testing/deliveries.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import {
  type CopilotzProcessorContext,
  createCopilotzEngine,
} from "./index.ts";
import {
  coreCollectionsPlugin,
  coreFeatureAliases,
} from "@copilotz/copilotz/plugins/core";
import {
  defineFeature,
  type FeatureExecuteContext,
} from "../features/index.ts";
import type { ActionCompletedData } from "../actions/index.ts";

Deno.test("features see the same deliveries from processor and direct contexts", async () => {
  const namespace = "tenant-feature-deliveries";
  let processorDeliveryIds: readonly string[] | undefined;
  let completedData: ActionCompletedData | undefined;
  const customAdapter = Object.freeze({ id: "adapter-a" });
  const feature = defineFeature({
    id: "test.delivery-probe",
    actions: {
      list: {
        inputSchema: { type: "object" } as const,
        async execute(_input: unknown, context: FeatureExecuteContext) {
          assertEquals(
            (context as unknown as {
              customAdapters: Record<string, unknown>;
            }).customAdapters.primary,
            customAdapter,
          );
          return (await context.deliveries.list()).map((delivery) =>
            delivery.id
          );
        },
      },
    },
  });
  const processor = defineProcessor<CopilotzProcessorContext>({
    id: "test.delivery-probe-processor",
    on: [{ eventType: "thread.created" }],
    requires: {
      features: { deliveryProbe: feature },
    },
    async handle(_event, context) {
      assertEquals(
        (context as unknown as {
          customAdapters: Record<string, unknown>;
        }).customAdapters.primary,
        customAdapter,
      );
      processorDeliveryIds = await context.features.deliveryProbe
        .list({}) as readonly string[];
    },
  });
  const completionProcessor = defineProcessor<CopilotzProcessorContext>({
    id: "test.delivery-probe-completed",
    on: [{ eventType: "test.delivery-probe.list.completed" }],
    handle(event) {
      completedData = event.data as ActionCompletedData;
    },
  });
  const plugin = definePlugin({
    id: "test.feature-delivery-parity",
    version: "1.0.0",
    features: [feature],
    processors: [processor, completionProcessor],
    context: {
      customAdapters: { primary: customAdapter },
    },
  });
  const db = await createTestDatabase({ url: ":memory:" });
  const engine = await createCopilotzEngine({
    session: db,
    registry: await createPluginRegistry({
      plugins: [coreCollectionsPlugin, plugin],
    }),
    defaultDatabaseSchema: "copilotz_feature_delivery_parity",
  });
  try {
    await createTestDomainContext(engine, namespace, coreFeatureAliases)
      .features.thread.create({
        id: "thread-a",
        participants: [{
          id: "user-a",
          externalId: "user-a",
          participantType: "human",
        }],
      });
    const created = (await engine.events.list({ namespace, limit: 100 })).find(
      (event) =>
        event.type === "thread.created" && event.subject?.id === "thread-a",
    );
    assertExists(created);
    await waitForTestDelivery(engine, namespace, created.id, "succeeded");
    const completed = (await engine.events.list({ namespace, limit: 100 }))
      .find(
        (event) => event.type === "test.delivery-probe.list.completed",
      );
    assertExists(completed);
    await waitForTestDelivery(engine, namespace, completed.id, "succeeded");
    assertExists(processorDeliveryIds);
    assertExists(completedData);
    assertEquals(completedData.status, "completed");
    assertEquals(completedData.input, {});
    assertEquals(completedData.output, processorDeliveryIds);

    const directDeliveryIds = (await engine.deliveries.list({ namespace }))
      .filter((delivery) =>
        delivery.consumerId !== "processor:test.delivery-probe-completed"
      )
      .map((delivery) => delivery.id);
    assertEquals(processorDeliveryIds, directDeliveryIds);
  } finally {
    await engine.shutdown();
    await db.close();
  }
});
