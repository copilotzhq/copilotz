import {
  assert,
  assertEquals,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { defineAction } from "../actions/define.ts";
import { defineCollection } from "../collections/definition.ts";
import {
  type CopilotzPlugin,
  createPluginRegistry,
  createTransientProcessorSet,
  definePlugin,
  defineProcessor,
  type ProcessorMatchClause,
} from "./index.ts";

function action(id: string) {
  return defineAction({
    id,
    execute(input: unknown) {
      return input;
    },
  });
}

function collection(name: string) {
  return defineCollection({
    name,
    schema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: true,
    } as const,
  });
}

function processor(id: string, eventType = "message.created") {
  return defineProcessor({
    id,
    on: [{ eventType }],
    handle: () => undefined,
  });
}

Deno.test("plugin definitions use direct identity and five keyed primitive maps", () => {
  const model = { adapter: "openai", model: "gpt-5" };
  const adapter = { call: () => "ok" };
  const search = action("search.query");
  const documents = collection("document");
  const indexDocument = processor("search.index", "document.created");
  const plugin = definePlugin({
    id: "@acme/search",
    version: "1.0.0",
    collections: { documents },
    actions: { search },
    processors: { indexDocument },
    resources: { models: { default: model } },
    adapters: { llm: { openai: adapter } },
  });

  assertEquals(plugin.id, "@acme/search");
  assertEquals(plugin.version, "1.0.0");
  assertStrictEquals(plugin.collections.documents, documents);
  assertStrictEquals(plugin.actions.search, search);
  assertStrictEquals(plugin.processors.indexDocument, indexDocument);
  assertStrictEquals(plugin.resources.models.default, model);
  assertStrictEquals(plugin.adapters.llm.openai, adapter);
  assert(Object.isFrozen(plugin));
  assert(Object.isFrozen(plugin.resources));
  assert(Object.isFrozen(plugin.resources.models));
  assert(!Object.isFrozen(model));
  assert(!Object.isFrozen(adapter));
  assertEquals("manifest" in plugin, false);
  assertEquals("context" in plugin, false);
});

Deno.test("dependencies compose once before dependents and root plugins", () => {
  const base = definePlugin({
    id: "acme.base",
    version: "1.0.0",
    resources: { agents: { support: { name: "Base" } } },
  });
  const child = definePlugin({
    id: "acme.child",
    version: "1.0.0",
    plugins: [base],
    resources: { agents: { support: { name: "Child" } } },
  });
  const sibling = definePlugin({
    id: "acme.sibling",
    version: "1.0.0",
    plugins: [base],
    resources: { agents: { researcher: { name: "Researcher" } } },
  });
  const registry = createPluginRegistry({ plugins: [child, sibling] });

  assertEquals(registry.plugins.map((plugin) => plugin.id), [
    "acme.base",
    "acme.child",
    "acme.sibling",
  ]);
  assertEquals(registry.resources.agents.support, { name: "Child" });
  assertEquals(registry.resources.agents.researcher, { name: "Researcher" });
});

Deno.test("same plugin object is idempotent while duplicate plugin identities fail", () => {
  const shared = definePlugin({ id: "acme.shared", version: "1.0.0" });
  const registry = createPluginRegistry({ plugins: [shared, shared] });
  assertEquals(registry.plugins, [shared]);

  const duplicate = definePlugin({ id: "acme.shared", version: "2.0.0" });
  assertThrows(
    () => createPluginRegistry({ plugins: [shared, duplicate] }),
    TypeError,
    "declared more than once",
  );

  assertThrows(
    () =>
      definePlugin({
        id: "acme.invalid-dependency",
        version: "1.0.0",
        plugins: [{ id: "raw" }] as unknown as readonly CopilotzPlugin[],
      }),
    TypeError,
    "definePlugin",
  );
});

Deno.test("Resources and Adapters overlay independently and application values are final", () => {
  const dependencyResource = { source: "dependency" };
  const pluginResource = { source: "plugin" };
  const applicationResource = { source: "application" };
  const dependencyAdapter = () => "dependency";
  const pluginAdapter = () => "plugin";
  const applicationAdapter = () => "application";
  const dependency = definePlugin({
    id: "acme.overlay-dependency",
    version: "1.0.0",
    resources: { shared: { default: dependencyResource } },
    adapters: { shared: { default: dependencyAdapter } },
  });
  const plugin = definePlugin({
    id: "acme.overlay",
    version: "1.0.0",
    plugins: [dependency],
    resources: { shared: { default: pluginResource } },
    adapters: { shared: { default: pluginAdapter } },
  });
  const registry = createPluginRegistry({
    plugins: [plugin],
    resources: { shared: { default: applicationResource } },
    adapters: { shared: { default: applicationAdapter } },
  });

  assertStrictEquals(registry.resources.shared.default, applicationResource);
  assertStrictEquals(registry.adapters.shared.default, applicationAdapter);
  assertEquals(
    (registry.adapters.shared.default as () => string)(),
    "application",
  );
});

Deno.test("registry preserves inferred overlay types", () => {
  const dependency = definePlugin({
    id: "acme.typed-dependency",
    version: "1.0.0",
    resources: {
      models: { fallback: { model: "fallback-model" as const } },
    },
  });
  const plugin = definePlugin({
    id: "acme.typed",
    version: "1.0.0",
    plugins: [dependency],
    resources: { models: { default: { model: "plugin-model" as const } } },
  });
  const registry = createPluginRegistry({
    plugins: [plugin],
    resources: { models: { default: { model: "application-model" as const } } },
  });
  const fallback: "fallback-model" = registry.resources.models.fallback.model;
  const selected: "application-model" = registry.resources.models.default.model;
  assertEquals([fallback, selected], ["fallback-model", "application-model"]);
});

Deno.test("executable aliases and stable IDs are unique", () => {
  const firstAction = action("search.first");
  const secondAction = action("search.second");
  const aliasA = definePlugin({
    id: "acme.action-alias-a",
    version: "1.0.0",
    actions: { search: firstAction },
  });
  const aliasB = definePlugin({
    id: "acme.action-alias-b",
    version: "1.0.0",
    actions: { search: secondAction },
  });
  assertThrows(
    () => createPluginRegistry({ plugins: [aliasA, aliasB] }),
    TypeError,
    "Action alias 'search'",
  );

  const idA = definePlugin({
    id: "acme.action-id-a",
    version: "1.0.0",
    actions: { first: action("shared.action") },
  });
  const idB = definePlugin({
    id: "acme.action-id-b",
    version: "1.0.0",
    actions: { second: action("shared.action") },
  });
  assertThrows(
    () => createPluginRegistry({ plugins: [idA, idB] }),
    TypeError,
    "Action id 'shared.action'",
  );

  const collectionA = definePlugin({
    id: "acme.collection-a",
    version: "1.0.0",
    collections: { first: collection("shared_collection") },
  });
  const collectionB = definePlugin({
    id: "acme.collection-b",
    version: "1.0.0",
    collections: { second: collection("shared_collection") },
  });
  assertThrows(
    () => createPluginRegistry({ plugins: [collectionA, collectionB] }),
    TypeError,
    "Collection id 'shared_collection'",
  );

  const processorA = definePlugin({
    id: "acme.processor-a",
    version: "1.0.0",
    processors: { first: processor("shared.processor") },
  });
  const processorB = definePlugin({
    id: "acme.processor-b",
    version: "1.0.0",
    processors: { second: processor("shared.processor") },
  });
  assertThrows(
    () => createPluginRegistry({ plugins: [processorA, processorB] }),
    TypeError,
    "Processor id 'shared.processor'",
  );
});

Deno.test("legacy fields and non-property aliases are rejected", () => {
  assertThrows(
    () =>
      definePlugin(
        {
          id: "acme.legacy",
          version: "1.0.0",
          agents: [],
        } as unknown as Parameters<typeof definePlugin>[0],
      ),
    TypeError,
    "cannot declare 'agents'",
  );
  assertThrows(
    () =>
      definePlugin({
        id: "acme.invalid-alias",
        version: "1.0.0",
        resources: { "not-valid": { value: 1 } },
      }),
    TypeError,
    "invalid alias",
  );
});

Deno.test("processor matching and durable consumer identity use direct registries", () => {
  const observer = defineProcessor({
    id: "memory.observe",
    on: [{ eventType: "message.created", namespace: "tenant-a" }],
    settlement: "detached",
    handle: () => undefined,
  });
  const plugin = definePlugin({
    id: "acme.processor",
    version: "1.0.0",
    processors: { observer },
  });
  const registry = createPluginRegistry({ plugins: [plugin] });
  const draft = {
    type: "message.created",
    namespace: "tenant-a",
    payload: {},
  } as const;

  assertStrictEquals(registry.processors.observer, observer);
  assertEquals(registry.matchDurable(draft), [observer]);
  assertEquals(registry.durableConsumers(draft), [{
    consumerId: "processor:memory.observe",
    settlement: "detached",
  }]);
  assertStrictEquals(
    registry.processorForConsumer("processor:memory.observe"),
    observer,
  );
});

Deno.test("static wildcard processors require a semantic structural guard", () => {
  const guarded = [
    defineProcessor({
      id: "audit.by-subject",
      on: [{ eventType: "*", subject: { type: "search.query" } }],
      handle: () => undefined,
    }),
    defineProcessor({
      id: "audit.by-metadata",
      on: [{ eventType: "*", metadata: { actionStatus: "completed" } }],
      handle: () => undefined,
    }),
    defineProcessor({
      id: "audit.by-data",
      on: [{ eventType: "*", data: { status: "completed" } }],
      handle: () => undefined,
    }),
  ] as const;
  const registry = createPluginRegistry({
    plugins: [definePlugin({
      id: "acme.guarded-wildcards",
      version: "1.0.0",
      processors: {
        bySubject: guarded[0],
        byMetadata: guarded[1],
        byData: guarded[2],
      },
    })],
  });
  assertEquals(Object.values(registry.processors), [...guarded]);
  assertEquals(
    registry.matchDurable({
      type: "search.query.completed",
      namespace: "tenant-a",
      subject: { type: "search.query", id: "run-a" },
      metadata: { actionStatus: "completed", trace: "trace-a" },
      payload: { status: "completed", output: { count: 3 } },
    }),
    [...guarded],
  );

  const invalidClauses = [
    { eventType: "*" },
    { eventType: "*", subject: {} },
    { eventType: "*", metadata: {} },
    { eventType: "*", data: {} },
    { eventType: "*", subject: [] },
    { eventType: "*", metadata: [] },
    { eventType: "*", data: [] },
    {
      eventType: "*",
      namespace: "tenant-a",
      threadId: "thread-a",
      routing: { senderId: "user-a" },
      visibility: { kind: "public" as const },
    },
  ] as const;
  for (const [index, clause] of invalidClauses.entries()) {
    const wildcard = defineProcessor({
      id: `audit.invalid-${index}`,
      on: [clause as ProcessorMatchClause],
      handle: () => undefined,
    });
    const plugin = definePlugin({
      id: `acme.invalid-wildcard-${index}`,
      version: "1.0.0",
      processors: { wildcard },
    });
    assertThrows(
      () => createPluginRegistry({ plugins: [plugin] }),
      TypeError,
      "cannot register static eventType '*' without a non-empty plain subject, metadata, or data matcher",
    );
  }
});

Deno.test("guarded durable wildcards match hydrated Action lifecycle data", () => {
  const completed = defineProcessor({
    id: "audit.action-completed",
    on: [{
      eventType: "*",
      data: { status: "completed", input: { tool: "search" } },
    }],
    settlement: "detached",
    handle: () => undefined,
  });
  const exact = defineProcessor({
    id: "audit.search-completed",
    on: [{ eventType: "search.query.completed" }],
    handle: () => undefined,
  });
  const registry = createPluginRegistry({
    plugins: [definePlugin({
      id: "acme.action-observers",
      version: "1.0.0",
      processors: { completed, exact },
    })],
  });
  const draft = {
    type: "search.query.completed",
    namespace: "tenant-a",
    payload: {
      dataRef: {
        eventBodyId: "action-body-a",
        schemaVersion: 1,
        mediaType: "application/json",
      },
    },
  } as const;

  assertEquals(registry.durableConsumers(draft), [{
    consumerId: "processor:audit.search-completed",
    settlement: "inherit",
  }]);
  assertEquals(
    registry.durableConsumers(draft, {
      actionRunId: "run-a",
      actionId: "search.query",
      status: "completed",
      input: { tool: "search", query: "weather" },
      output: { resultCount: 3 },
    }),
    [
      {
        consumerId: "processor:audit.action-completed",
        settlement: "detached",
      },
      {
        consumerId: "processor:audit.search-completed",
        settlement: "inherit",
      },
    ],
  );
  assertEquals(
    registry.durableConsumers({
      ...draft,
      type: "other.action.completed",
    }, {
      actionRunId: "run-b",
      actionId: "other.action",
      status: "completed",
      input: { tool: "search" },
      output: {},
    }),
    [{
      consumerId: "processor:audit.action-completed",
      settlement: "detached",
    }],
  );
});

Deno.test("transient processors retain unrestricted wildcard observation", () => {
  const wildcard = defineProcessor({
    id: "audit.all-transient",
    on: [{ eventType: "*" }],
    handle: () => undefined,
  });

  const transients = createTransientProcessorSet([wildcard]);
  const event = {
    durable: false,
    type: "audio.delta",
    namespace: "tenant-a",
    payload: new Uint8Array([1, 2]),
    routing: {},
    visibility: { kind: "public" },
    metadata: {},
    correlationId: "correlation-a",
    streamId: "stream-a",
    sequence: 1,
    createdAt: new Date().toISOString(),
  } as const;
  assertEquals(transients.match(event), [wildcard]);
});

Deno.test("plugin composition core stays runtime-neutral", async () => {
  for (
    const module of ["index.ts", "processor.ts", "registry.ts", "types.ts"]
  ) {
    const source = await Deno.readTextFile(new URL(module, import.meta.url));
    assert(!/\bDeno\b|\bBun\b|\bprocess\b/.test(source));
    assert(!/from\s+["']node:/.test(source));
    assert(!/loaders\/resources|runtime\/cli|server\//.test(source));
    assert(!/manifest|provides|PluginResourceType/.test(source));
  }
});
