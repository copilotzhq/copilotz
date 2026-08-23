import { assertEquals, assertExists } from "@std/assert";
import {
  type ActionCaller,
  type ActionCompletedData,
  type ActionContext,
  defineAction,
  type RuntimeContextNamespaces,
} from "../actions/index.ts";
import {
  createPluginRegistry,
  definePlugin,
  defineProcessor,
  type ProcessorContext,
} from "../plugins/index.ts";
import { createTestDomainContext } from "../testing/domain-context.ts";
import { waitForTestDelivery } from "../testing/deliveries.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { coreCollectionsPlugin } from "@copilotz/copilotz/plugins/core";
import { createCopilotzEngine } from "./index.ts";

const EXECUTOR_FIELDS = Object.freeze([
  "databaseSchema",
  "event",
  "delivery",
  "settlementScopeId",
  "idempotencyKey",
  "dispatchAttemptId",
  "createMutationIdentity",
]);

type ProbeResult = Readonly<{
  namespace: string;
  adapterId: string;
  operationKey: string;
  hasSignal: boolean;
  hasStreams: boolean;
  executorFields: readonly string[];
}>;

Deno.test("Actions and Processors receive one runtime-neutral composed context", async () => {
  const namespace = "tenant-action-context";
  let processorResult: ProbeResult | undefined;
  let completedData: ActionCompletedData | undefined;
  const customAdapter = Object.freeze({ id: "adapter-a" });
  type AdapterNamespaces =
    & RuntimeContextNamespaces
    & Readonly<{
      custom: Readonly<{ primary: typeof customAdapter }>;
    }>;
  type ProbeActionContext =
    & Omit<ActionContext, "adapters">
    & Readonly<{ adapters: AdapterNamespaces }>;
  const probeAction = defineAction<unknown, ProbeResult, ProbeActionContext>({
    id: "test.context.probe",
    execute(_input, context) {
      return Object.freeze({
        namespace: context.namespace,
        adapterId: context.adapters.custom.primary.id,
        operationKey: context.operationKey,
        hasSignal: context.signal instanceof AbortSignal,
        hasStreams: typeof context.streams.open === "function",
        executorFields: Object.freeze(
          EXECUTOR_FIELDS.filter((key) => Object.hasOwn(context, key)),
        ),
      });
    },
  });
  type ProbeProcessorContext =
    & Omit<ProcessorContext, "actions" | "adapters">
    & Readonly<{
      actions: Readonly<{ probe: ActionCaller<typeof probeAction> }>;
      adapters: AdapterNamespaces;
    }>;
  const processor = defineProcessor<ProbeProcessorContext>({
    id: "test.context.processor",
    on: [{ eventType: "thread.created" }],
    async handle(_event, context) {
      assertEquals(context.adapters.custom.primary, customAdapter);
      assertEquals(
        EXECUTOR_FIELDS.filter((key) => Object.hasOwn(context, key)),
        [],
      );
      processorResult = await context.actions.probe({});
    },
  });
  const completionProcessor = defineProcessor<ProcessorContext>({
    id: "test.context.completed",
    on: [{ eventType: "test.context.probe.completed" }],
    handle(event) {
      completedData = event.data as ActionCompletedData;
    },
  });
  const plugin = definePlugin({
    id: "test.action-context",
    version: "1.0.0",
    actions: { probe: probeAction },
    processors: { probe: processor, completion: completionProcessor },
    adapters: { custom: { primary: customAdapter } },
  });
  const db = await createTestDatabase({ url: ":memory:" });
  const engine = await createCopilotzEngine({
    session: db,
    registry: await createPluginRegistry({
      plugins: [coreCollectionsPlugin, plugin],
    }),
    defaultDatabaseSchema: "copilotz_action_context",
  });
  try {
    const directContext = createTestDomainContext(engine, namespace);
    const directResult = await directContext.actions.probe({}, {
      operationKey: "direct-probe",
    }) as ProbeResult;
    assertEquals(directResult.executorFields, []);
    assertEquals(directResult.adapterId, customAdapter.id);
    assertEquals(directResult.namespace, namespace);
    assertEquals(directResult.hasSignal, true);
    assertEquals(directResult.hasStreams, true);

    await directContext.actions.createThread({
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
      .find((event) => event.type === "test.context.probe.completed");
    assertExists(completed);
    await waitForTestDelivery(engine, namespace, completed.id, "succeeded");

    assertExists(processorResult);
    assertEquals(processorResult.executorFields, []);
    assertEquals(processorResult.adapterId, customAdapter.id);
    assertEquals(processorResult.namespace, namespace);
    assertEquals(processorResult.hasSignal, true);
    assertEquals(processorResult.hasStreams, true);
    assertExists(completedData);
    assertEquals(completedData.status, "completed");
    assertEquals(completedData.output, processorResult);
  } finally {
    await engine.shutdown();
    await db.close();
  }
});
