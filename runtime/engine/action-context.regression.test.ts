import { assertEquals, assertExists } from "@std/assert";
import {
  type ActionCaller,
  type ActionCompletedData,
  type ActionContext,
  type ActionContextNamespaces,
  defineAction,
} from "../actions/index.ts";
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
import { coreCollectionsPlugin } from "@copilotz/copilotz/plugins/core";

Deno.test("Actions see the same deliveries from processor and direct contexts", async () => {
  const namespace = "tenant-action-deliveries";
  let processorDeliveryIds: readonly string[] | undefined;
  let completedData: ActionCompletedData | undefined;
  const customAdapter = Object.freeze({ id: "adapter-a" });
  type AdapterNamespaces =
    & ActionContextNamespaces
    & Readonly<{
      custom: Readonly<{ primary: typeof customAdapter }>;
    }>;
  type DeliveryProbeContext =
    & Omit<ActionContext, "adapters">
    & Readonly<{
      adapters: AdapterNamespaces;
    }>;
  const inputSchema = { type: "object" } as const;
  const deliveryProbeAction = defineAction<
    unknown,
    readonly string[],
    DeliveryProbeContext,
    typeof inputSchema
  >({
    id: "test.delivery-probe.list",
    inputSchema,
    async execute(_input, context) {
      assertEquals(context.adapters.custom.primary, customAdapter);
      return (await context.deliveries.list()).map((delivery) => delivery.id);
    },
  });
  type ProbeProcessorContext =
    & Omit<CopilotzProcessorContext, "actions" | "adapters">
    & Readonly<{
      actions: Readonly<{
        deliveryProbe: ActionCaller<typeof deliveryProbeAction>;
      }>;
      adapters: AdapterNamespaces;
    }>;
  const processor = defineProcessor<ProbeProcessorContext>({
    id: "test.delivery-probe-processor",
    on: [{ eventType: "thread.created" }],
    async handle(_event, context) {
      assertEquals(context.adapters.custom.primary, customAdapter);
      processorDeliveryIds = await context.actions.deliveryProbe({});
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
    id: "test.action-delivery-parity",
    version: "1.0.0",
    actions: { deliveryProbe: deliveryProbeAction },
    processors: { deliveryProbe: processor, completion: completionProcessor },
    adapters: { custom: { primary: customAdapter } },
  });
  const db = await createTestDatabase({ url: ":memory:" });
  const engine = await createCopilotzEngine({
    session: db,
    registry: await createPluginRegistry({
      plugins: [coreCollectionsPlugin, plugin],
    }),
    defaultDatabaseSchema: "copilotz_action_delivery_parity",
  });
  try {
    await createTestDomainContext(engine, namespace).actions.createThread({
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
