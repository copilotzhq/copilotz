import { assert, assertEquals, assertThrows } from "@std/assert";
import { type AgentResource, defineAgent } from "./agent.ts";

Deno.test("AgentResource is a plain Core resource with explicit aliases", () => {
  const agent = {
    id: "assistant",
    name: "Assistant",
    role: "Help the participant",
    instructions: "Be concise.",
    personality: "Thoughtful",
    description: "Default application assistant",
    models: { generate: "default", session: "realtime" },
    capabilities: {
      tools: ["search", "calculator"],
      agents: ["researcher"],
      skills: ["writing"],
    },
    metadata: { owner: "application" },
  } as const satisfies AgentResource;

  assertEquals(agent.models.generate, "default");
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
    models: { generate: "default" },
    capabilities: { tools: ["search"] },
    metadata: { source: "fixture" },
  });

  const inferredId: "assistant" = agent.id;
  const inferredModel: "default" | undefined = agent.models.generate;
  assertEquals(inferredId, "assistant");
  assertEquals(inferredModel, "default");
  assertEquals(agent, {
    id: "assistant",
    name: "Assistant",
    role: "helper",
    models: { generate: "default" },
    capabilities: { tools: ["search"] },
    metadata: { source: "fixture" },
  });
  assert(Object.isFrozen(agent));
  assert(Object.isFrozen(agent.models));
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
        models: { generate: "default" },
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
        models: { generate: "invalid-model" },
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
