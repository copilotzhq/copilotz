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
import { coreCollectionsPlugin } from "../../plugins/core/plugin.ts";
import type { FeatureResource } from "../features/index.ts";

Deno.test("features see the same deliveries from processor and direct contexts", async () => {
  const namespace = "tenant-feature-deliveries";
  let processorDeliveryIds: readonly string[] | undefined;
  const feature: FeatureResource = Object.freeze({
    id: "test.delivery-probe",
    alias: "deliveryProbe",
    mode: "read",
    actions: {
      async list(_input, context) {
        return (await context.deliveries.list()).map((delivery) => delivery.id);
      },
    },
  });
  const processor = defineProcessor<CopilotzProcessorContext>({
    id: "test.delivery-probe-processor",
    on: [{ eventType: "thread.created" }],
    async handle(_event, context) {
      processorDeliveryIds = await context.features.deliveryProbe
        .list() as readonly string[];
    },
  });
  const plugin = definePlugin({
    manifest: {
      id: "test.feature-delivery-parity",
      version: "1.0.0",
      provides: {
        features: [feature.id],
        processors: [processor.id],
      },
    },
    resources: {
      features: [feature],
      processors: [processor],
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
    await createTestDomainContext(engine, namespace).features.thread.create({
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
    assertExists(processorDeliveryIds);

    const directDeliveryIds = (await engine.deliveries.list({ namespace }))
      .map((delivery) => delivery.id);
    assertEquals(processorDeliveryIds, directDeliveryIds);
  } finally {
    await engine.shutdown();
    await db.close();
  }
});
