import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  createPluginRegistry,
  definePlugin,
  defineProcessor,
  type Processor,
} from "./index.ts";

function plugin(input: {
  id: string;
  agents?: readonly object[];
  tools?: readonly object[];
  processors?: readonly Processor[];
  presets?: Readonly<Record<string, readonly string[]>>;
}) {
  return definePlugin({
    manifest: {
      id: input.id,
      version: "1.0.0",
      provides: {
        ...(input.agents
          ? {
            agents: input.agents.map((agent) => (agent as { id: string }).id),
          }
          : {}),
        ...(input.tools
          ? {
            tools: input.tools.map((tool) => (tool as { key: string }).key),
          }
          : {}),
        ...(input.processors
          ? { processors: input.processors.map((processor) => processor.id) }
          : {}),
      },
      presets: input.presets,
    },
    resources: {
      agents: input.agents,
      tools: input.tools,
      processors: input.processors,
    },
  });
}

Deno.test("plugin manifests and presets validate stable provided resources", () => {
  const valid = plugin({
    id: "acme.valid",
    agents: [{ id: "support", name: "Support" }],
    tools: [{ id: "random-database-id", key: "lookup", name: "Lookup" }],
    presets: { core: ["agents.support", "tools.lookup"] },
  });
  assert(Object.isFrozen(valid));
  assert(Object.isFrozen(valid.manifest.provides.tools));
  assertEquals(valid.manifest.provides.tools, ["lookup"]);

  assertThrows(
    () =>
      definePlugin({
        manifest: {
          id: "acme.invalid",
          version: "1.0.0",
          provides: { agents: ["missing"] },
        },
        resources: { agents: [{ id: "present" }] },
      }),
    TypeError,
    "mismatch",
  );
  assertThrows(
    () =>
      definePlugin({
        manifest: {
          id: "acme.invalid-preset",
          version: "1.0.0",
          provides: { agents: ["present"] },
          presets: { broken: ["agents.missing"] },
        },
        resources: { agents: [{ id: "present" }] },
      }),
    TypeError,
    "unknown resource",
  );
});

Deno.test("plugin composition precedence is core, declaration order, then application", async () => {
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
    resources: { agents: [{ id: "support", name: "Application" }] },
  });

  assertEquals(
    registry.require<{ id: string; name: string }>("agents", "support").name,
    "Application",
  );
  assertEquals(
    registry.list<{ id: string; name: string }>("agents").map((agent) =>
      agent.id
    ),
    ["research", "support"],
  );
  assertEquals(registry.origin("agents", "support"), {
    pluginId: "@copilotz/application",
  });
  assertEquals(registry.origin("agents", "research"), {
    pluginId: "acme.first",
    pluginVersion: "1.0.0",
  });
});

Deno.test("context and memory-kind resources follow the same stable-ID override rules", async () => {
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
  const resourcePlugin = (id: string, context: object, kind: object) =>
    definePlugin({
      manifest: {
        id,
        version: "1.0.0",
        provides: { context: ["workspace"], memoryKinds: ["acme.signal"] },
      },
      resources: { context: [context], memoryKinds: [kind] },
    });
  const registry = await createPluginRegistry({
    plugins: [
      resourcePlugin("first", contextA, kindA),
      resourcePlugin("second", contextB, kindB),
    ],
  });

  assertEquals(registry.require("context", "workspace"), contextB);
  assertEquals(
    registry.require<{ description: string }>("memoryKinds", "acme.signal")
      .description,
    "replacement",
  );
  assertEquals(
    registry.origin("memoryKinds", "acme.signal")?.pluginId,
    "second",
  );
});

Deno.test("resolver-loaded plugins support named imports and presets", async () => {
  const remote = plugin({
    id: "acme.remote",
    agents: [
      { id: "support", name: "Support" },
      { id: "sales", name: "Sales" },
    ],
    tools: [
      { key: "lookup", name: "Lookup" },
      { key: "write", name: "Write" },
    ],
    presets: { support: ["agents.support", "tools.lookup"] },
  });
  const resolved: string[] = [];
  const registry = await createPluginRegistry({
    plugins: [{
      source: "jsr:@acme/copilotz-plugin@^2",
      presets: ["support"],
      imports: ["agents.sales"],
    }],
    resolver: {
      resolve(source) {
        resolved.push(source);
        return Promise.resolve({ default: remote });
      },
    },
  });

  assertEquals(resolved, ["jsr:@acme/copilotz-plugin@^2"]);
  assertEquals(
    registry.list<{ id: string }>("agents").map((agent) => agent.id),
    ["support", "sales"],
  );
  assertEquals(
    registry.list<{ key: string }>("tools").map((tool) => tool.key),
    ["lookup"],
  );
  await assertRejects(
    () =>
      createPluginRegistry({
        plugins: [{ source: "remote", imports: ["tools.missing"] }],
        resolver: { resolve: () => Promise.resolve(remote) },
      }),
    TypeError,
    "does not provide",
  );
});

Deno.test("processor stable IDs override while different IDs remain independent", async () => {
  const calls: string[] = [];
  const first = defineProcessor({
    id: "memory.observe",
    on: ["message.created"],
    delivery: "durable",
    handle: () => {
      calls.push("first");
    },
  });
  const replacement = defineProcessor({
    id: "memory.observe",
    on: ["message.created"],
    delivery: "durable",
    handle: () => {
      calls.push("replacement");
    },
  });
  const independent = defineProcessor({
    id: "audit.observe",
    on: ["message.created"],
    delivery: "durable",
    settlement: "detached",
    filter: (event) => event.namespace === "tenant-a",
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

  assertEquals(registry.matchDurable(draft), [replacement, independent]);
  assertEquals(registry.durableConsumers(draft), [
    { consumerId: "processor:memory.observe", settlement: "inherit" },
    { consumerId: "processor:audit.observe", settlement: "detached" },
  ]);
  assertEquals(
    registry.processorForConsumer("processor:memory.observe"),
    replacement,
  );
  for (const processor of registry.matchDurable(draft)) {
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
    }, {});
  }
  assertEquals(calls, ["replacement", "independent"]);
});

Deno.test("durable matching rejects asynchronous filters before commit", async () => {
  const invalid = defineProcessor({
    id: "invalid.async-filter",
    on: ["control.created"],
    delivery: "durable",
    filter: (() => Promise.resolve(true)) as unknown as () => boolean,
    handle: () => undefined,
  });
  const registry = await createPluginRegistry({
    plugins: [plugin({ id: "invalid", processors: [invalid] })],
  });
  assertThrows(
    () =>
      registry.durableConsumers({
        type: "control.created",
        namespace: "tenant-a",
        payload: {},
      }),
    TypeError,
    "synchronous and pure",
  );
});

Deno.test("live subscriptions receive ephemeral events without durable matching", async () => {
  assertThrows(
    () =>
      defineProcessor({
        id: "invalid.detached-live",
        on: ["audio.delta"],
        delivery: "live",
        settlement: "detached",
        handle: () => undefined,
      }),
    TypeError,
    "cannot use detached durable settlement",
  );
  const live = defineProcessor({
    id: "captions.live",
    on: ["audio.delta"],
    delivery: "live",
    handle: () => undefined,
  });
  const registry = await createPluginRegistry({
    plugins: [plugin({ id: "live", processors: [live] })],
  });
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
  assertEquals(registry.matchLive(event), [live]);
  assertEquals(
    registry.matchDurable({
      type: "audio.delta",
      namespace: "tenant-a",
      payload: {},
    }),
    [],
  );
});

Deno.test("A55 plugin core is runtime-neutral and contains no legacy processor controls", async () => {
  for (
    const module of ["index.ts", "processor.ts", "registry.ts", "types.ts"]
  ) {
    const source = await Deno.readTextFile(new URL(module, import.meta.url));
    assert(!/\bDeno\b|\bBun\b|\bprocess\b/.test(source));
    assert(!/from\s+["']node:/.test(source));
    assert(!/\bclass\s+\w+/.test(source));
    assert(!/loaders\/resources|runtime\/cli|server\//.test(source));
    assert(!/producedEvents|shouldProcess|\bpriority\b/.test(source));
  }
});
