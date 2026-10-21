import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  createPluginRegistry,
  defineProcessor,
} from "@copilotz/copilotz/plugins";
import { defineView } from "@copilotz/copilotz/views";
import {
  callLlmAction,
  type LlmAdapter,
  type LlmAdapterRequest,
} from "@copilotz/copilotz/llm";
import { messageCollection } from "@copilotz/copilotz/core";
import {
  type CopilotzEngine,
  createCopilotzEngine,
} from "../../../../../runtime/engine/index.ts";
import { createTestDatabase } from "../../../../../runtime/testing/ominipg.ts";
import { waitForTestDelivery } from "../../../../../runtime/testing/deliveries.ts";
import { defineContextResource } from "../../../authoring/define-context/index.ts";
import type { CoreProcessorContext } from "../../../shared/runtime-context.ts";
import { buildCoreLlmRequest } from "./prompt.ts";
import { createContextViewRenderer } from "./context-views.ts";

Deno.test("Core authorized View prompt capture survives owner restart and completed Action replay", async () => {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
  });
  const schema = `context_view_${crypto.randomUUID().replaceAll("-", "")}`;
  const scope = {
    namespace: "workspace",
    agentId: "assistant",
    participantId: "participant",
    threadId: "thread",
  };
  const timestamps = {
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const resourceId = "app.record-context";
  const requests: LlmAdapterRequest[] = [];
  const outputs: unknown[] = [];
  let source = {
    title: "first authorized title",
    hidden: "HIDDEN-SOURCE",
    protected: "PROTECTED-SOURCE",
  };
  let preparations = 0,
    contributions = 0,
    projections = 0,
    renders = 0,
    deliveries = 0;
  const adapter: LlmAdapter = {
    call(input) {
      requests.push(structuredClone(input.request));
      return {
        frames: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        result: Promise.resolve({
          content: "Authorized context received.",
          attempts: [{ status: "completed" }],
        }),
      };
    },
  };
  const compose = (revision: string) => {
    const processor = defineProcessor<CoreProcessorContext>({
      id: "app.prepare-prompt",
      on: [{ eventType: "app.prompt-requested" }],
      async handle(_event, context) {
        deliveries++;
        const result = await context.actions.callLlm.prepare(async () => {
          preparations++;
          const renderContextContribution = createContextViewRenderer({
            registry,
            bindings: { [resourceId]: "record" },
            resources: { labels: { record: revision } },
            project(request) {
              projections++;
              // The admitted Processor's immutable context supplies authority.
              // Selectors from the contribution are checked, never trusted alone.
              assertEquals(context.namespace, scope.namespace);
              assertEquals({ ...request.scope }, scope);
              assertEquals(request.contribution.resourceId, resourceId);
              assert(
                typeof request.content !== "string" &&
                  request.content.type === "json",
              );
              const value = request.content.value;
              assert(
                value && typeof value === "object" && !Array.isArray(value),
              );
              const title = (value as Record<string, unknown>).title;
              assert(typeof title === "string");
              return { title };
            },
          });
          const request = await buildCoreLlmRequest(context, {
            agent: {
              id: scope.agentId,
              name: "Assistant",
              role: "assistant",
              models: {},
            },
            participant: {
              ...timestamps,
              namespace: scope.namespace,
              id: scope.participantId,
              externalId: scope.agentId,
              participantType: "agent",
              metadata: {},
            },
            thread: {
              ...timestamps,
              namespace: scope.namespace,
              id: scope.threadId,
              status: "active",
              participants: [],
              metadata: {},
            },
            history: [],
            messageIds: [],
            tools: [],
            renderContextContribution,
          });
          return {
            input: {
              mode: "generate",
              models: [{ connection: "primary", model: "recording" }],
              request,
            },
          };
        }, { operationKey: "first-turn" });
        outputs.push(structuredClone(result));
        // Only the parent delivery fails. The actual owner has committed the
        // child Action receipt and provider result before this interruption.
        if (deliveries === 1) throw new Error("injected parent interruption");
      },
    });
    const registry = createPluginRegistry({
      actions: { callLlm: callLlmAction },
      processors: { preparePrompt: processor },
      collections: { message: messageCollection },
      adapters: { llm: { recording: adapter } },
      resources: {
        llmConnections: { primary: { adapter: "recording" } },
        agents: {},
        promptInstructions: {},
        secretCredentials: { provider: "UNAPPROVED-RESOURCE" },
        promptContext: {
          record: defineContextResource({
            id: resourceId,
            type: "context",
            purposes: ["conversation"],
            contribute() {
              contributions++;
              return {
                id: "record",
                title: "Record",
                role: "context",
                content: { type: "json", value: source },
              };
            },
          }),
          literal: defineContextResource({
            id: "app.literal",
            type: "context",
            purposes: ["conversation"],
            contribute: () => ({
              id: "literal",
              title: "Literal",
              role: "context",
              content: "literal fallback",
            }),
          }),
        },
      },
      views: {
        record: defineView<{ title: string }, string>({
          id: `app.record.${revision}`,
          shows: "record",
          renderer: "text",
          modes: ["context"],
          render(value, context) {
            renders++;
            assertEquals(Object.keys(value), ["title"]);
            assertEquals(Object.keys(context.resources), ["labels"]);
            assertEquals(Object.keys(context.collections), []);
            assertEquals(Object.keys(context.actions), []);
            return `${revision}: ${value.title} (${context.resources.labels.record})`;
          },
        }),
      },
    });
    return registry;
  };
  const start = (revision: string) =>
    createCopilotzEngine({
      session: db,
      registry: compose(revision),
      defaultDatabaseSchema: schema,
      retryBaseMs: 0,
      random: () => 0,
      // Explicit test scheduler keeps fault/restart boundaries deterministic.
      alarmScheduler: { schedule: (callback) => callback, cancel() {} },
    });
  let engine: CopilotzEngine | undefined;
  try {
    engine = await start("first");
    const admitted = await engine.events.append({
      type: "app.prompt-requested",
      namespace: scope.namespace,
      payload: {},
    });
    const event = admitted.event;
    assert(event);
    const first = await waitForTestDelivery(
      engine,
      scope.namespace,
      event.id,
      "retry_wait",
      10_000,
    );
    await engine.execution.settleOutputs({
      databaseSchema: schema,
      namespace: scope.namespace,
      settlementScopeId: first.settlementScopeId,
    });
    assertEquals(requests.length, 1);
    assertStringIncludes(
      requests[0].instructions ?? "",
      "first: first authorized title (first)",
    );
    assertStringIncludes(requests[0].instructions ?? "", "literal fallback");
    assertEquals({ preparations, contributions, projections, renders }, {
      preparations: 1,
      contributions: 1,
      projections: 1,
      renders: 1,
    });
    const captured = await db.query<{ body: unknown }>(
      `SELECT body FROM "${schema}".event_bodies`,
    );
    const durable = JSON.stringify(captured.rows);
    assertStringIncludes(durable, "first authorized title");
    for (
      const secret of [source.hidden, source.protected, "UNAPPROVED-RESOURCE"]
    ) {
      assertEquals(durable.includes(secret), false);
      assertEquals(JSON.stringify(requests).includes(secret), false);
    }
    await engine.shutdown();
    engine = undefined;
    source = {
      title: "changed source",
      hidden: "NEW-HIDDEN",
      protected: "NEW-PROTECTED",
    };
    engine = await start("replacement");
    await engine.recover({ namespace: scope.namespace });
    await waitForTestDelivery(
      engine,
      scope.namespace,
      event.id,
      "succeeded",
      10_000,
    );
    assertEquals(deliveries, 2);
    assertEquals(
      requests.length,
      1,
      "completed provider work must not be dispatched again",
    );
    assertEquals(outputs[1], outputs[0]);
    assertEquals({ preparations, contributions, projections, renders }, {
      preparations: 1,
      contributions: 1,
      projections: 1,
      renders: 1,
    });
    assertEquals(
      (await db.query<{ body: unknown }>(
        `SELECT body FROM "${schema}".event_bodies WHERE body::text LIKE '%changed source%'`,
      )).rows,
      [],
    );
  } finally {
    await engine?.shutdown();
    await db.close();
  }
});
