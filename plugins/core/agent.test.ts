import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  agentInstructionBase,
  type AgentResource,
  defineAgent,
} from "./index.ts";

Deno.test("AgentResource is a plain Core resource with explicit aliases", () => {
  const agent = {
    id: "assistant",
    name: "Assistant",
    role: "Help the participant",
    instructions: "Be concise.",
    personality: "Thoughtful",
    description: "Default application assistant",
    models: { generate: ["default"], session: ["realtime"] },
    capabilities: {
      tools: ["search", "calculator"],
      agents: ["researcher"],
      skills: ["writing"],
    },
    metadata: { owner: "application" },
  } as const satisfies AgentResource;

  assertEquals(agent.models.generate, ["default"]);
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
    models: { generate: ["default", "backup"] },
    capabilities: { tools: ["search"] },
    metadata: { source: "fixture" },
  });

  const inferredId: "assistant" = agent.id;
  const inferredModels: readonly ["default", "backup"] | undefined =
    agent.models.generate;
  assertEquals(inferredId, "assistant");
  assertEquals(inferredModels, ["default", "backup"]);
  assertEquals(agent, {
    id: "assistant",
    name: "Assistant",
    role: "helper",
    models: { generate: ["default", "backup"] },
    capabilities: { tools: ["search"] },
    metadata: { source: "fixture" },
  });
  assert(Object.isFrozen(agent));
  assert(Object.isFrozen(agent.models));
  assert(Object.isFrozen(agent.models.generate));
  assert(Object.isFrozen(agent.capabilities));
  assert(Object.isFrozen(agent.capabilities?.tools));
  assert(Object.isFrozen(agent.metadata));
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
        models: { generate: ["default"] },
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
        models: { generate: ["invalid-model"] },
      }),
    TypeError,
    "invalid alias",
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
        models: { generate: ["default", "default"] },
      }),
    TypeError,
    "duplicate generate model aliases",
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

Deno.test("defineAgent keeps a dynamic instruction hook process-local and frozen", () => {
  const dynamic = defineAgent({
    id: "dynamic",
    name: "Dynamic",
    role: "helper",
    models: { generate: ["default"] },
    instructions: { base: "base", resolve: () => "override" },
  });
  assert(Object.isFrozen(dynamic));
  assert(typeof dynamic.instructions === "object");
  assert(Object.isFrozen(dynamic.instructions));
  assertEquals(agentInstructionBase(dynamic.instructions), "base");
  assertEquals("instructionResolver" in dynamic, false);
});

Deno.test("defineAgent validates dynamic instruction declarations", () => {
  assertThrows(
    () =>
      defineAgent({
        id: "dynamic",
        name: "Dynamic",
        role: "helper",
        models: {},
        instructions: { base: "base" },
      } as unknown as AgentResource),
    TypeError,
    "requires resolve",
  );
  assertThrows(
    () =>
      defineAgent({
        id: "dynamic",
        name: "Dynamic",
        role: "helper",
        models: {},
        instructions: { base: " base ", resolve: () => null },
      } as unknown as AgentResource),
    TypeError,
    "must not contain surrounding whitespace",
  );
  const accessorResolver: Record<string, unknown> = {};
  Object.defineProperty(accessorResolver, "resolve", {
    enumerable: true,
    get: () => {
      throw new Error("must not execute");
    },
  });
  assertThrows(
    () =>
      defineAgent({
        id: "accessor-resolver",
        name: "Accessor Resolver",
        role: "helper",
        models: {},
        instructions:
          accessorResolver as unknown as AgentResource["instructions"],
      }),
    TypeError,
    "requires resolve",
  );
  const accessorBase: Record<string, unknown> = { resolve: () => null };
  Object.defineProperty(accessorBase, "base", {
    enumerable: true,
    get: () => {
      throw new Error("must not execute");
    },
  });
  assertThrows(
    () =>
      defineAgent({
        id: "accessor-base",
        name: "Accessor Base",
        role: "helper",
        models: {},
        instructions: accessorBase as unknown as AgentResource["instructions"],
      }),
    TypeError,
    "requires resolve",
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
  assert(Object.isFrozen(agent.metadata));
  assert(Object.isFrozen(agent.metadata?.nested));
  assert(Object.isFrozen(agent.metadata?.labels));

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
