import {
  deepStrictEqual,
  equal,
  match,
  ok,
  rejects,
  throws,
} from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { findPluginBoundaryFailures } from "../../../../../scripts/check-plugin-boundaries.ts";
import {
  createActionCallers,
  createActionLifecycleAppender,
  createActionLifecycleEmitter,
  createActionLifecycleLoader,
  type RuntimeContent,
} from "@copilotz/copilotz/actions";
import {
  createContentPreparer,
  createContentResolver,
  createMemoryAssetRepository,
  type PreparedContent,
} from "@copilotz/copilotz/content";
import {
  createEventCoordinator,
  createEventStore,
  provisionCopilotzSchema,
} from "@copilotz/copilotz/events";
import { createPluginRegistry } from "@copilotz/copilotz/plugins";
import { defineView } from "@copilotz/copilotz/views";
import {
  callLlmAction,
  type LlmActionContext,
  type LlmAdapter,
  type LlmAdapterRequest,
  type LlmCallInput,
} from "@copilotz/copilotz/llm";
import { createDeliveryExecutor } from "../../../../../runtime/execution/index.ts";
import { createTestDatabase } from "../../../../../runtime/testing/ominipg.ts";
import { createTestProcessorContext } from "../../../../../runtime/testing/processor-context.ts";
import { defineContextResource } from "../../../authoring/define-context/index.ts";
import type { CollectedContextContribution } from "../../../shared/contributions.ts";
import type { CoreProcessorContext } from "../../../shared/runtime-context.ts";
import { createContextViewRenderer } from "./context-views.ts";
import { buildCoreLlmRequest } from "./prompt.ts";

const scope = {
  namespace: "tenant-a",
  agentId: "agent-a",
  participantId: "participant-a",
  threadId: "thread-a",
};
const timestamps = {
  createdAt: "2026-10-16T23:00:00.000Z",
  updatedAt: "2026-10-16T23:00:00.000Z",
};
const contribution: CollectedContextContribution = {
  resourceId: "app.customer-context",
  id: "customer-a",
  title: "Customer",
  role: "context",
  content: { type: "json", value: { title: "visible", hidden: "HIDDEN" } },
};
const resource = defineContextResource({
  id: contribution.resourceId,
  type: "context",
  purposes: ["conversation"],
  contribute: () => contribution,
});
function input(signal = new AbortController().signal) {
  return {
    contribution,
    content: contribution.content as { type: "json"; value: unknown },
    scope,
    signal,
  };
}

test("the private Context View helper uses the unchanged public-import boundary", async () => {
  const root = new URL("../../../../../", import.meta.url);
  const paths = [
    "plugins/core/processors/message-router/agents/context-views.ts",
    "runtime/views/index.ts",
    "runtime/views/definition.ts",
  ];
  const sources = await Promise.all(paths.map(async (path) => ({
    path,
    text: await readFile(new URL(path, root), "utf8"),
  })));
  const mappings = JSON.parse(
    await readFile(new URL("deno.json", root), "utf8"),
  );
  deepStrictEqual(findPluginBoundaryFailures(sources, mappings), []);
});

test("Context View bindings validate registered stable IDs and require host projection", async () => {
  const registry = createPluginRegistry({
    resources: { promptContext: { alias: resource } },
  });
  throws(
    () =>
      createContextViewRenderer({
        registry,
        bindings: {},
        project: undefined as never,
      }),
    /projection is required/,
  );
  for (
    const bindings of [
      { alias: "customer" },
      { missing: "customer" },
      { [resource.id]: { unsupported: "customer" } },
      { [resource.id]: " " },
    ]
  ) {
    throws(
      () =>
        createContextViewRenderer({
          registry,
          bindings: bindings as never,
          project: () => ({}),
        }),
      TypeError,
    );
  }
  const duplicate = createPluginRegistry({
    resources: { promptContext: { one: resource, two: { ...resource } } },
  });
  throws(
    () =>
      createContextViewRenderer({
        registry: duplicate,
        bindings: { [resource.id]: "customer" },
        project: () => ({}),
      }),
    /one registered Context resource/,
  );
  let projections = 0;
  const render = createContextViewRenderer({
    registry,
    bindings: { [resource.id]: "customer" },
    project(request) {
      projections++;
      deepStrictEqual({ ...request.scope }, scope);
      equal(request.reference.shows, "customer");
      // The host explicitly selects plain authorized fields; raw source values
      // never become generic fallback output merely because no View matches.
      return { title: "authorized" };
    },
  });
  equal(await render(input()), '{"title":"authorized"}');
  equal(projections, 1);
  equal(
    await render({
      ...input(),
      contribution: { ...contribution, resourceId: "unbound" },
    }),
    undefined,
  );
  equal(projections, 1);
  const denied = createContextViewRenderer({
    registry,
    bindings: { [resource.id]: "customer" },
    project: () => {
      throw new Error("Current agent is not authorized");
    },
  });
  await rejects(() => Promise.resolve(denied(input())), /not authorized/);
});

test("Context View nested projections share cancellation and expose no read or Action capabilities", async () => {
  let nestedStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    nestedStarted = resolve;
  });
  let nestedSignal: AbortSignal | undefined;
  const registry = createPluginRegistry({
    resources: { promptContext: { customer: resource } },
    views: {
      customer: defineView({
        id: "app.customer",
        shows: "customer",
        renderer: "text",
        modes: ["context"],
        async render(_value, context) {
          deepStrictEqual(Object.keys(context.collections), []);
          deepStrictEqual(Object.keys(context.actions), []);
          return await context.show({
            shows: "nested",
            value: { id: "child" },
          });
        },
      }),
    },
  });
  const render = createContextViewRenderer({
    registry,
    bindings: { [resource.id]: "customer" },
    project(request) {
      deepStrictEqual({ ...request.scope }, scope);
      if (request.reference.shows === "nested") {
        nestedSignal = request.signal;
        nestedStarted();
        return new Promise((_resolve, reject) =>
          request.signal.addEventListener(
            "abort",
            () => reject(request.signal.reason),
            { once: true },
          )
        );
      }
      return { title: "authorized" };
    },
  });
  const controller = new AbortController();
  const rendering = render(input(controller.signal));
  await started;
  controller.abort(new Error("preparation cancelled"));
  await rejects(() => Promise.resolve(rendering), /preparation cancelled/);
  equal(nestedSignal?.aborted, true);
});

test("real callLlm.prepare captures authorized View text once and replays durable input after source, View and Resource changes", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const schema = "context_view_capture";
  await provisionCopilotzSchema(db, schema);
  const store = createEventStore({ session: db, schema });
  const requests: LlmAdapterRequest[] = [];
  const adapter: LlmAdapter = {
    call(request) {
      requests.push(structuredClone(request.request));
      return {
        frames: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        result: Promise.resolve({
          content: [],
          attempts: [{ status: "completed" as const }],
        }),
      };
    },
  };
  const assets = createMemoryAssetRepository();
  const resolver = createContentResolver({ assets });
  const preparer = createContentPreparer();
  const content: RuntimeContent = {
    prepare: (value, options) =>
      preparer.prepare(value, {
        namespace: scope.namespace,
        idempotencyKey: options.operationKey,
      }),
    materialize(value) {
      // The recording Adapter returns no output bodies; no fake prepared-input
      // cache participates in the lifecycle being exercised.
      if (Array.isArray(value)) return Promise.resolve(value);
      equal((value as PreparedContent).assets.length, 0);
      return Promise.resolve((value as PreparedContent).content);
    },
    authorize: (ref) => resolver.authorize(ref, { namespace: scope.namespace }),
    get: (id) => assets.get(scope.namespace, id),
    getMany: (ids) => assets.getMany(scope.namespace, ids),
    resolve: (ref) => resolver.get(ref, { namespace: scope.namespace }),
    resolveMany: (refs) =>
      resolver.getMany(refs, { namespace: scope.namespace }),
    publish: () => {
      throw new Error("No input body publication expected");
    },
    open: () => {
      throw new Error("No input body open expected");
    },
  };
  let source = {
    title: "first authorized title",
    hidden: "HIDDEN-SOURCE",
    protected: "PROTECTED-SOURCE",
  };
  let preparations = 0;
  let contributions = 0;
  let projections = 0;
  let renders = 0;
  const compose = (revision: string) =>
    createPluginRegistry({
      actions: { callLlm: callLlmAction },
      adapters: { llm: { recording: adapter } },
      resources: {
        llmConnections: { primary: { adapter: "recording" } },
        promptContext: {
          customer: defineContextResource({
            ...resource,
            contribute() {
              contributions++;
              return {
                ...contribution,
                content: { type: "json", value: source },
              };
            },
          }),
          unbound: defineContextResource({
            id: "app.unbound",
            type: "context",
            purposes: ["conversation"],
            contribute: () => ({
              id: "literal",
              title: "Literal",
              role: "context",
              content: "legacy literal fallback",
            }),
          }),
        },
        labels: { customer: revision },
      },
      views: {
        customer: defineView<{ title: string }, string>({
          id: "app.customer",
          shows: "customer",
          renderer: "text",
          modes: ["context"],
          render(value, context) {
            renders++;
            deepStrictEqual(Object.keys(value), ["title"]);
            deepStrictEqual(Object.keys(context.collections), []);
            deepStrictEqual(Object.keys(context.actions), []);
            return `${revision}: ${value.title} (${context.resources.labels.customer})`;
          },
        }),
      },
    });
  let registry = compose("first");
  const executor = createDeliveryExecutor({
    store,
    registry,
    workerId: "view-capture",
    createContext: createTestProcessorContext,
  });
  const coordinator = createEventCoordinator({
    store,
    registry,
    executor,
    publish: () => {},
  });
  const append = createActionLifecycleAppender({
    store,
    coordinator,
    actions: registry.actions,
  });
  let loseTerminal = true;
  const lifecycle = createActionLifecycleEmitter({
    namespace: scope.namespace,
    load: createActionLifecycleLoader({ store, actions: registry.actions }),
    append(input) {
      if (loseTerminal && input.data.status !== "invoked") {
        throw new Error("injected terminal receipt failure");
      }
      return append(input);
    },
  });
  const signal = new AbortController().signal;
  const processorContext = (): CoreProcessorContext => ({
    ...createTestProcessorContext({
      event: {
        durable: false,
        namespace: scope.namespace,
        type: "fixture",
        correlationId: "correlation",
        payload: {},
        metadata: {},
        createdAt: timestamps.createdAt,
      },
      idempotencyKey: "view-capture",
      signal,
    }),
    resources: registry.resources,
    adapters: registry.adapters,
    content,
    collections: { message: { list: () => Promise.resolve([]) } },
  } as unknown as CoreProcessorContext);
  const callers = () =>
    createActionCallers(registry.actions, {
      actionLifecycle: lifecycle,
      content,
      signal,
      invocationScope: "delivery:view-capture",
      createContext({ frame, progress, actions }) {
        return {
          ...processorContext(),
          actions,
          action: {
            id: frame.actionId,
            runId: frame.actionRunId,
            metadata: frame.metadata,
          },
          progress,
          registerDeferredWait() {
            throw new Error("No deferred wait expected");
          },
        } as LlmActionContext;
      },
    });
  const prepare = async (): Promise<{ input: LlmCallInput }> => {
    preparations++;
    // Projection and rendering happen INSIDE the actual Action prepare factory,
    // after receipt lookup. This is not default message-router/owner wiring.
    const renderContextContribution = createContextViewRenderer({
      registry,
      bindings: { [resource.id]: "customer" },
      resources: { labels: registry.resources.labels },
      project(request) {
        projections++;
        // Fixture admission is exactly this tenant/agent/thread/participant.
        // These selectors alone are not credentials. A real host must consult
        // its admitted execution and current policy before returning projection.
        deepStrictEqual({ ...request.scope }, scope);
        equal(request.contribution.resourceId, resource.id);
        ok(
          typeof request.content !== "string" &&
            request.content.type === "json",
        );
        const value = request.content.value as typeof source;
        return { title: value.title };
      },
    });
    const request = await buildCoreLlmRequest(
      processorContext(),
      {
        agent: {
          id: scope.agentId,
          name: "Agent",
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
          status: "active",
          id: scope.threadId,
          participants: [],
          metadata: {},
        },
        history: [],
        messageIds: [],
        tools: [],
        renderContextContribution,
      },
    );
    return {
      input: {
        models: [{ connection: "primary", model: "recording-model" }],
        mode: "generate",
        request,
      },
    };
  };
  try {
    await rejects(
      () => callers().callLlm.prepare(prepare, { operationKey: "turn" }),
      /injected terminal receipt failure/,
    );
    equal(requests.length, 1);
    match(
      requests[0].instructions ?? "",
      /first: first authorized title \(first\)/,
    );
    match(requests[0].instructions ?? "", /legacy literal fallback/);
    const runId = "delivery:view-capture:action:llm.call:turn";
    const receipt = await lifecycle.invoked(runId);
    ok(receipt);
    equal(await lifecycle.terminal(runId), null);
    const receiptText = JSON.stringify(receipt);
    ok(receiptText.includes("first authorized title"));
    for (const secret of [source.hidden, source.protected]) {
      equal(receiptText.includes(secret), false);
      equal(JSON.stringify(requests).includes(secret), false);
    }
    source = {
      title: "new source",
      hidden: "NEW-HIDDEN",
      protected: "NEW-PROTECTED",
    };
    registry = compose("replacement");
    loseTerminal = false;
    const output = await callers().callLlm.prepare(prepare, {
      operationKey: "turn",
    });
    equal(
      requests.length,
      2,
      "invoked-only recovery executes the Adapter again",
    );
    deepStrictEqual(requests[1], requests[0]);
    deepStrictEqual({ preparations, contributions, projections, renders }, {
      preparations: 1,
      contributions: 1,
      projections: 1,
      renders: 1,
    });
    const terminal = await lifecycle.terminal(runId);
    ok(terminal && terminal.status === "completed");
    deepStrictEqual(
      await callers().callLlm.prepare(prepare, { operationKey: "turn" }),
      output,
    );
    equal(requests.length, 2, "terminal replay does not call the Adapter");
    deepStrictEqual({ preparations, contributions, projections, renders }, {
      preparations: 1,
      contributions: 1,
      projections: 1,
      renders: 1,
    });
    const bodies = await db.query<{ body: unknown }>(
      `SELECT body FROM ${store.tables.event_bodies}`,
    );
    const durable = JSON.stringify(bodies.rows);
    equal(durable.includes("HIDDEN-SOURCE"), false);
    equal(durable.includes("PROTECTED-SOURCE"), false);
  } finally {
    await executor.shutdown();
    await db.close();
  }
});
