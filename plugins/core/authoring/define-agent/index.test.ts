import { assertEquals, assertThrows } from "@std/assert";
import { type AgentResource, defineAgent } from "./index.ts";

Deno.test("AgentResource is a plain Core resource with explicit aliases", () => {
  const agent = {
    id: "assistant",
    name: "Assistant",
    role: "Help the participant",
    instructions: "Be concise.",
    personality: "Thoughtful",
    description: "Default application assistant",
    models: {
      generate: [{ connection: "default", model: "default" }],
      session: [{ connection: "realtime", model: "realtime" }],
    },
    capabilities: {
      tools: ["search", "calculator"],
      agents: ["researcher"],
      skills: ["writing"],
    },
    metadata: { owner: "application" },
  } as const satisfies AgentResource;

  assertEquals(agent.models.generate, [{
    connection: "default",
    model: "default",
  }]);
  assertEquals(agent.capabilities.tools, ["search", "calculator"]);

  type HasProvider = "provider" extends keyof AgentResource ? true : false;
  type HasClient = "client" extends keyof AgentResource ? true : false;
  type HasCredential = "credential" extends keyof AgentResource ? true : false;
  const hasProvider: HasProvider = false;
  const hasClient: HasClient = false;
  const hasCredential: HasCredential = false;
  assertEquals([hasProvider, hasClient, hasCredential], [false, false, false]);
});

Deno.test("defineAgent preserves inference while validating and freezing", () => {
  const agent = defineAgent({
    id: "assistant",
    name: "Assistant",
    role: "helper",
    models: {
      generate: [{ connection: "default", model: "default" }, {
        connection: "backup",
        model: "backup",
      }],
    },
    capabilities: { tools: ["search"] },
    metadata: { source: "fixture" },
  });

  const inferredId: "assistant" = agent.id;
  const inferredModels:
    | readonly [
      { readonly connection: "default"; readonly model: "default" },
      { readonly connection: "backup"; readonly model: "backup" },
    ]
    | undefined = agent.models.generate;
  assertEquals(inferredId, "assistant");
  assertEquals(inferredModels, [{ connection: "default", model: "default" }, {
    connection: "backup",
    model: "backup",
  }]);
  assertEquals(agent, {
    id: "assistant",
    name: "Assistant",
    role: "helper",
    models: {
      generate: [{ connection: "default", model: "default" }, {
        connection: "backup",
        model: "backup",
      }],
    },
    capabilities: { tools: ["search"] },
    metadata: { source: "fixture" },
  });
});

Deno.test("defineAgent rejects provider fields and invalid selection aliases", () => {
  assertThrows(
    () =>
      defineAgent({
        id: " assistant ",
        name: "Assistant",
        role: "helper",
        models: {},
      }),
    TypeError,
    "must not contain surrounding whitespace",
  );
  assertThrows(
    () =>
      defineAgent({
        id: "assistant",
        name: "Assistant",
        role: "helper",
        models: { generate: [{ connection: "default", model: "default" }] },
        provider: "openai",
      } as unknown as AgentResource),
    TypeError,
    "cannot declare 'provider'",
  );
  assertThrows(
    () =>
      defineAgent({
        id: "assistant",
        name: "Assistant",
        role: "helper",
        models: { generate: [{ connection: "", model: "invalid-model" }] },
      }),
    TypeError,
    "non-empty string",
  );
  assertThrows(
    () =>
      defineAgent({
        id: "assistant",
        name: "Assistant",
        role: "helper",
        models: { generate: [] },
      } as unknown as AgentResource),
    TypeError,
    "non-empty array",
  );
  assertThrows(
    () =>
      defineAgent({
        id: "assistant",
        name: "Assistant",
        role: "helper",
        models: {
          generate: [{ connection: "default", model: "default" }, {
            connection: "default",
            model: "default",
          }],
        },
      }),
    TypeError,
    "duplicate selections",
  );
  assertThrows(
    () =>
      defineAgent({
        id: "assistant",
        name: "Assistant",
        role: "helper",
        models: { generate: "default" },
      } as unknown as AgentResource),
    TypeError,
    "non-empty array",
  );
  assertThrows(
    () =>
      defineAgent({
        id: "assistant",
        name: "Assistant",
        role: "helper",
        models: {},
        capabilities: { tools: ["search", "search"] },
      }),
    TypeError,
    "duplicate tools capability aliases",
  );
  assertThrows(
    () =>
      defineAgent({
        id: "assistant",
        name: "Assistant",
        role: "helper",
        models: {},
        capabilities: { tools: { all: true } },
      } as unknown as AgentResource),
    TypeError,
    "must be an array of aliases",
  );
});

Deno.test("defineAgent accepts canonical hyphenated Skill names", () => {
  const value = defineAgent({
    id: "assistant",
    name: "Assistant",
    role: "helper",
    models: {},
    capabilities: { skills: ["lab-explainer"] },
  });
  assertEquals(value.capabilities?.skills, ["lab-explainer"]);
  assertThrows(
    () =>
      defineAgent({
        id: "assistant",
        name: "Assistant",
        role: "helper",
        models: {},
        capabilities: { skills: ["Lab-Explainer"] },
      }),
    TypeError,
    "canonical Skill name",
  );
});

Deno.test("defineAgent keeps a dynamic resolver process-local", () => {
  const dynamic = defineAgent({
    id: "dynamic",
    name: "Dynamic",
    role: "helper",
    models: { generate: [{ connection: "default", model: "default" }] },
    instructions: "base",
    dynamicResolve: () => ({ instructions: "override" }),
  });

  assertEquals(dynamic.instructions, "base");
  assertEquals(typeof dynamic.dynamicResolve, "function");
});

Deno.test("defineAgent validates dynamic resolver declarations", () => {
  assertThrows(
    () =>
      defineAgent({
        id: "dynamic",
        name: "Dynamic",
        role: "helper",
        models: {},
        dynamicResolve: "bad",
      } as unknown as AgentResource),
    TypeError,
    "dynamicResolve must be a function",
  );
  assertThrows(
    () =>
      defineAgent({
        id: "dynamic",
        name: "Dynamic",
        role: "helper",
        models: {},
        instructions: { base: "base", resolve: () => null },
      } as unknown as AgentResource),
    TypeError,
    "instructions must be text",
  );
  assertThrows(
    () =>
      defineAgent({
        id: "accessor-resolver",
        name: "Accessor Resolver",
        role: "helper",
        models: {},
        dynamicResolve: Object.create(null),
      }),
    TypeError,
    "dynamicResolve must be a function",
  );
});

Deno.test("defineAgent clones and deep-freezes JSON Agent metadata", () => {
  const source = { nested: { label: "original" }, labels: ["one"] };
  const agent = defineAgent({
    id: "assistant",
    name: "Assistant",
    role: "helper",
    models: {},
    metadata: source,
  });
  source.nested.label = "mutated";
  source.labels.push("two");
  assertEquals(agent.metadata, {
    nested: { label: "original" },
    labels: ["one"],
  });

  const accessorMetadata: Record<string, unknown> = {};
  Object.defineProperty(accessorMetadata, "computed", {
    enumerable: true,
    get: () => "not read",
  });
  assertThrows(
    () =>
      defineAgent({
        id: "accessor",
        name: "Accessor",
        role: "helper",
        models: {},
        metadata: accessorMetadata,
      }),
    TypeError,
    "enumerable data property",
  );
  assertThrows(
    () =>
      defineAgent({
        id: "non-json",
        name: "Non JSON",
        role: "helper",
        models: {},
        metadata: { callback: () => undefined },
      }),
    TypeError,
    "only JSON values",
  );
  const nullPrototype = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(nullPrototype, "__proto__", {
    enumerable: true,
    value: { preserved: true },
  });
  const protoSafe = defineAgent({
    id: "proto-safe",
    name: "Proto Safe",
    role: "helper",
    models: {},
    metadata: nullPrototype,
  });
  assertEquals(Object.getPrototypeOf(protoSafe.metadata), Object.prototype);
  assertEquals(protoSafe.metadata?.["__proto__"], { preserved: true });
});
