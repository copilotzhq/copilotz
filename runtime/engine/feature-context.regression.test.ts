import { assertEquals, assertExists } from "@std/assert";

import { coreCollectionsPlugin } from "../../plugins/core/plugin.ts";
import type { FeatureResource } from "../features/index.ts";
import {
  createPluginRegistry,
  definePlugin,
  defineProcessor,
} from "../plugins/index.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import {
  type CopilotzProcessorContext,
  createCopilotzEngine,
} from "./index.ts";

Deno.test("features see the same deliveries from processor and direct contexts", async () => {
  const namespace = "tenant-feature-deliveries";
  let processorDeliveryIds: readonly string[] | undefined;
  const feature: FeatureResource = Object.freeze({
    id: "test.delivery-probe",
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
      processorDeliveryIds = await context.features.invoke(
        feature.id,
        "list",
      ) as readonly string[];
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
    const created = await engine.conversation.createThread({
      namespace,
      id: "thread-a",
      participants: [{
        id: "user-a",
        externalId: "user-a",
        participantType: "human",
      }],
    });
    await Promise.all(created.dispatch.handles.map((handle) => handle.done));
    assertExists(processorDeliveryIds);

    const directDeliveryIds = (await engine.deliveries.list({ namespace }))
      .map((delivery) => delivery.id);
    assertEquals(processorDeliveryIds, directDeliveryIds);
  } finally {
    await engine.shutdown();
    await db.close();
  }
});
