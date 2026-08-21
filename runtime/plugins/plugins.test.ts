import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  createPluginRegistry,
  createTransientProcessorSet,
  definePlugin,
  defineProcessor,
  type Processor,
} from "./index.ts";

function plugin(input: {
  id: string;
  agents?: readonly object[];
  tools?: readonly object[];
  processors?: readonly Processor[];
  plugins?: Parameters<typeof definePlugin>[0]["plugins"];
  context?: Parameters<typeof definePlugin>[0]["context"];
}) {
  return definePlugin({
    id: input.id,
    version: "1.0.0",
    plugins: input.plugins,
    context: input.context,
    agents: input.agents,
    tools: input.tools,
    processors: input.processors,
  });
}

Deno.test("plugin manifests validate stable provided resources", () => {
  const valid = plugin({
    id: "acme.valid",
    agents: [{ id: "support", name: "Support" }],
    tools: [{ id: "random-database-id", key: "lookup", name: "Lookup" }],
  });
  assert(Object.isFrozen(valid));
  assert(Object.isFrozen(valid.manifest.provides.tools));
  assertEquals(valid.manifest.provides.tools, ["lookup"]);

  assertThrows(
    () =>
      definePlugin({
        id: "acme.invalid",
        version: "1.0.0",
        agents: [{ id: "present" }, { id: "present" }],
      }),
    TypeError,
    "duplicate",
  );
});

Deno.test("plugin composition precedence is core, declaration order, then application context", async () => {
  const core = plugin({
    id: "@copilotz/core",
    agents: [{ id: "support", name: "Core" }],
  });
  const first = plugin({
    id: "acme.first",
    agents: [
      { id: "support", name: "First" },
      { id: "research", name: "Research" },
    ],
  });
  const second = plugin({
    id: "acme.second",
    agents: [{ id: "support", name: "Second" }],
  });
  const registry = await createPluginRegistry({
    core,
    plugins: [first, second],
    context: { agents: { support: { id: "support", name: "Application" } } },
  });

  assertEquals(
    (registry.context.agents.support as { id: string; name: string }).name,
    "Application",
  );
  assertEquals(
    (registry.context.agents.research as { id: string; name: string }).name,
    "Research",
  );
});

Deno.test("plugin dependencies compose before the declaring plugin", async () => {
  const base = plugin({
    id: "acme.base",
    agents: [{ id: "support", name: "Base" }],
    tools: [{ key: "lookup", name: "Lookup" }],
  });
  const child = plugin({
    id: "acme.child",
    plugins: [base],
    agents: [{ id: "support", name: "Child" }],
  });
  const sibling = plugin({
    id: "acme.sibling",
    plugins: [base],
    agents: [{ id: "research", name: "Research" }],
  });
  const registry = await createPluginRegistry({
    plugins: [child, sibling],
  });

  assertEquals(
    registry.plugins.map((registered) => registered.manifest.id),
    ["acme.base", "acme.child", "acme.sibling"],
  );
  assertEquals(
    (registry.context.agents.support as { name: string }).name,
    "Child",
  );
  assertEquals(
    (registry.context.tools.lookup as { name: string }).name,
    "Lookup",
  );
  assertEquals(
    (registry.context.agents.support as { name: string }).name,
    "Child",
  );
  assertEquals(
    (registry.context.tools.lookup as { name: string }).name,
    "Lookup",
  );
});

Deno.test("plugin property context composes with dependency and application precedence", async () => {
  const dependencySearch = Object.freeze({
    key: "provider-search",
    name: "Provider Search",
  });
  const childSearch = Object.freeze({
    key: "child-search",
    name: "Child Search",
  });
  const applicationSearch = Object.freeze({
    key: "application-search",
    name: "Application Search",
  });
  const base = plugin({
    id: "acme.context-base",
    context: { tools: { search: dependencySearch } },
  });
  const child = plugin({
    id: "acme.context-child",
    plugins: [base],
    context: {
      tools: { search: childSearch },
      agents: { assistant: { id: "assistant" } },
    },
  });
  const registry = await createPluginRegistry({
    plugins: [child],
    context: { tools: { search: applicationSearch } },
  });

  assertEquals(registry.context.tools.search, applicationSearch);
  assertEquals(registry.context.agents.assistant, { id: "assistant" });
});

Deno.test("plugin dependency cycles and duplicate identities fail", async () => {
  const first: Record<string, unknown> = {
    id: "acme.first",
    version: "1.0.0",
  };
  const second: Record<string, unknown> = {
    id: "acme.second",
    version: "1.0.0",
    plugins: [first],
  };
  first.plugins = [second];

  assertThrows(
    () => definePlugin(first as Parameters<typeof definePlugin>[0]),
    TypeError,
    "cycle",
  );

  assertThrows(
    () =>
      createPluginRegistry({
        plugins: [
          plugin({ id: "acme.duplicate" }),
          plugin({ id: "acme.duplicate" }),
        ],
      }),
    TypeError,
    "declared more than once",
  );
});

Deno.test("prompt context and memory-kind context follow stable override rules", async () => {
  const contextA = {
    id: "workspace",
    type: "context",
    purposes: ["conversation"],
    contribute: () => null,
  };
  const contextB = { ...contextA, purposes: ["memory_consolidation"] };
  const kindA = {
    id: "acme.signal",
    form: "assertion",
    description: "first",
  };
  const kindB = { ...kindA, description: "replacement" };
  const resourcePlugin = (
    id: string,
    context: object,
    kind: { id: string },
  ) =>
    definePlugin({
      id,
      version: "1.0.0",
      context: {
        promptContext: { [(context as { id: string }).id]: context },
        memoryKinds: { [kind.id as string]: kind },
      },
    });
  const registry = await createPluginRegistry({
    plugins: [
      resourcePlugin("first", contextA, kindA),
      resourcePlugin("second", contextB, kindB),
    ],
  });

  assertEquals(registry.context.promptContext.workspace, contextB);
  assertEquals(
    (registry.context.memoryKinds["acme.signal"] as { description: string })
      .description,
    "replacement",
  );
});

Deno.test("processor stable IDs override while different IDs remain independent", async () => {
  const calls: string[] = [];
  const first = defineProcessor({
    id: "memory.observe",
    on: [{ eventType: "message.created" }],
    handle: () => {
      calls.push("first");
    },
  });
  const replacement = defineProcessor({
    id: "memory.observe",
    on: [{ eventType: "message.created" }],
    handle: () => {
      calls.push("replacement");
    },
  });
  const independent = defineProcessor({
    id: "audit.observe",
    on: [{ eventType: "message.created", namespace: "tenant-a" }],
    settlement: "detached",
    handle: () => {
      calls.push("independent");
    },
  });
  const registry = await createPluginRegistry({
    plugins: [
      plugin({ id: "first", processors: [first] }),
      plugin({ id: "second", processors: [replacement, independent] }),
    ],
  });
  const draft = {
    type: "message.created",
    namespace: "tenant-a",
    payload: { id: "message-a" },
  } as const;

  assertEquals(registry.processors.matchDurable(draft), [
    replacement,
    independent,
  ]);
  assertEquals(registry.processors.durableConsumers(draft), [
    { consumerId: "processor:memory.observe", settlement: "inherit" },
    { consumerId: "processor:audit.observe", settlement: "detached" },
  ]);
  assertEquals(
    registry.processors.processorForConsumer("processor:memory.observe"),
    replacement,
  );
  for (const processor of registry.processors.matchDurable(draft)) {
    await processor.handle({
      durable: true,
      id: "event-a",
      position: "1",
      schemaVersion: 3,
      ...draft,
      routing: {},
      visibility: { kind: "public" },
      metadata: {},
      correlationId: "event-a",
      createdAt: new Date().toISOString(),
      data: draft.payload,
    }, {});
  }
  assertEquals(calls, ["replacement", "independent"]);
});

Deno.test("defineProcessor rejects string matchers", () => {
  assertThrows(
    () =>
      defineProcessor({
        id: "invalid.string-on",
        on: ["control.created"] as unknown as Processor["on"],
        handle: () => undefined,
      }),
    TypeError,
    "matcher object",
  );
});

Deno.test("transient processors observe events without durable matching", async () => {
  const live = defineProcessor({
    id: "captions.live",
    on: [{ eventType: "audio.delta" }],
    handle: () => undefined,
  });
  const registry = await createPluginRegistry({
    plugins: [plugin({ id: "static", processors: [] })],
  });
  const transients = createTransientProcessorSet([live]);
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
  assertEquals(transients.match(event), [live]);
  assertEquals(
    registry.processors.matchDurable({
      type: "audio.delta",
      namespace: "tenant-a",
      payload: {},
    }),
    [],
  );
});

Deno.test("A55 plugin core is runtime-neutral and contains no legacy processor controls", async () => {
  for (
    const module of [
      "index.ts",
      "processor.ts",
      "registry.ts",
      "types.ts",
      "match.ts",
    ]
  ) {
    const source = await Deno.readTextFile(new URL(module, import.meta.url));
    assert(!/\bDeno\b|\bBun\b|\bprocess\b/.test(source));
    assert(!/from\s+["']node:/.test(source));
    assert(!/\bclass\s+\w+/.test(source));
    assert(!/loaders\/resources|runtime\/cli|server\//.test(source));
    assert(!/producedEvents|shouldProcess|\bpriority\b/.test(source));
    assert(!/ProcessorDelivery|\bfilter\?:/.test(source));
  }
});
