import { definePlugin as defineFixturePlugin } from "@copilotz/copilotz/plugins";
import { assertEquals, assertRejects } from "@std/assert";

import { createPluginRegistry, definePlugin } from "@copilotz/copilotz/plugins";
import { defineAction } from "@copilotz/copilotz/actions";
import type {
  AgentCapabilitySelection,
  AgentResource,
} from "../../authoring/define-agent/index.ts";
import {
  defineInlineSkill,
  defineSkill,
  skillsPlugin,
} from "@copilotz/copilotz/skills";
import { corePlugin } from "@copilotz/copilotz/core";
import { defineTool } from "@copilotz/copilotz/core";
import { agentCapabilities } from "../../resources/capabilities/default/index.ts";
import { selectCapabilityResources } from "./selection.ts";

const clockAction = defineAction({
  id: "test.clock",
  execute: () => "12:00",
});

const clock = defineTool("clock", clockAction, {
  name: "Clock",
  description: "Returns a contract time.",
});

const guide = defineInlineSkill({
  directoryName: "contract-guide",
  markdown: `---
name: contract-guide
description: Guides capability contract tests through one explicit skill.
---
Follow the contract.`,
  files: { "references/details.md": "# Details" },
});

function agents(): readonly AgentResource[] {
  return Object.freeze([{
    id: "coordinator",
    name: "Coordinator",
    role: "Coordinates work.",
    models: {},
    capabilities: {
      tools: [clock.action],
      agents: ["researcher"],
      skills: [guide.name],
    },
  }, {
    id: "researcher",
    name: "Researcher",
    role: "Researches without ambient authority.",
    models: {},
  }]);
}

async function registry() {
  const values = agents();
  const application = definePlugin({
    id: "test.capabilities.application",
    version: "1.0.0",
    actions: { clock: clockAction },
    resources: {
      agents: Object.fromEntries(values.map((agent) => [agent.id, agent])),
      tools: { clock },
    },
  });
  return await createPluginRegistry({
    plugins: [
      corePlugin,
      defineFixturePlugin({
        ...skillsPlugin,
        id: "test.capabilities.skills",
        version: "1.0.0",
        resources: {
          ...skillsPlugin.resources,
          skills: Object.fromEntries(
            [guide].map((skill) => [skill.name, skill]),
          ),
          skillConfig: { default: { maximumTextBytes: undefined } },
        },
      }),
      application,
    ],
  });
}

function capabilityContext(value: {
  resources: Readonly<Record<string, unknown>>;
  actions: Readonly<Record<string, unknown>>;
}) {
  return {
    resources: value.resources,
    // Capability resolution runs against composed runtime callers. The test
    // registry stores Action definitions, so provide callable stand-ins here.
    actions: Object.fromEntries(
      Object.keys(value.actions).map((alias) => [alias, async () => undefined]),
    ),
  } as never;
}

Deno.test("capability selections are least-authority explicit aliases", () => {
  const resources = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const select = (selection?: AgentCapabilitySelection) =>
    selectCapabilityResources({
      agentId: "contract-agent",
      kind: "tool",
      selection,
      resources,
      id: (resource) => resource.id,
    }).map((resource) => resource.id);

  assertEquals(select(), []);
  assertEquals(select(["c", "a"]), ["c", "a"]);
});

Deno.test("resolver derives ask and skill mechanisms from higher-level grants", async () => {
  const resources = await registry();
  const resolver = resources.resources.capabilities.default;
  const resolved = await resolver.resolve(
    { agent: "coordinator" },
    capabilityContext(resources),
  );

  assertEquals(resolved.agents.map((entry) => entry.id), ["researcher"]);
  assertEquals(resolved.skills.map((entry) => entry.id), ["contract-guide"]);
  assertEquals(
    resolved.tools.map((entry) => [entry.id, entry.grant]),
    [
      ["clock", "explicit"],
      ["ask", "derived"],
      ["readToolResult", "derived"],
      ["list_skills", "derived"],
      ["load_skill", "derived"],
      ["read_skill_resource", "derived"],
    ],
  );
  assertEquals(resolved.tools[0].resource.action, "clock");
  assertEquals("origin" in resolved.tools[0], false);

  const restricted = await resolver.resolve(
    { agent: "researcher" },
    capabilityContext(resources),
  );
  assertEquals(restricted.tools.map((entry) => entry.id), ["readToolResult"]);
  assertEquals(restricted.agents, []);
  assertEquals(restricted.skills, []);
});

Deno.test("resolver rejects unknown grants instead of silently broadening access", async () => {
  const resources = await registry();
  const invalid: AgentResource = {
    id: "invalid",
    name: "Invalid",
    role: "Contract fixture",
    models: {},
    capabilities: { tools: ["missing"] },
  };
  const overriding = definePlugin({
    id: "test.capabilities.invalid",
    version: "1.0.0",
    resources: { agents: { [invalid.id]: invalid } },
  });
  const combined = await createPluginRegistry({
    plugins: [...resources.plugins, overriding],
  });
  const resolver = (combined.resources as unknown as {
    capabilities: { default: typeof agentCapabilities };
  }).capabilities.default;
  await assertRejects(
    async () =>
      await resolver.resolve(
        { agent: invalid.id },
        capabilityContext(combined),
      ),
    Error,
    "grants unknown tool 'missing'",
  );
});

Deno.test("a final-root capability Resource overrides the Skills overlay", async () => {
  const resources = await registry();
  const overridden = createPluginRegistry({
    plugins: resources.plugins,
    resources: { capabilities: { default: agentCapabilities } },
  });
  const resolver = (overridden.resources as {
    capabilities: { default: typeof agentCapabilities };
  }).capabilities.default;
  const resolved = resolver.resolve(
    { agent: "coordinator" },
    capabilityContext(overridden),
  );

  assertEquals(resolved.skills.map((entry) => entry.id), ["contract-guide"]);
  assertEquals(
    resolved.tools.map((entry) => [entry.id, entry.grant]),
    [
      ["clock", "explicit"],
      ["ask", "derived"],
      ["readToolResult", "derived"],
    ],
  );
});

Deno.test("external Skill locators do not derive a reader or implicit fetch tool", async () => {
  const resources = await registry();
  const external = defineSkill({
    manifest: {
      name: "contract-guide",
      description: "An externally hosted capability contract guide.",
    },
    files: [{ path: "SKILL.md", mediaType: "text/markdown;charset=utf-8" }],
    locator: "https://example.test/skills/contract-guide/SKILL.md",
    read: () => "---\nname: contract-guide\ndescription: guide\n---\n# Guide",
  });
  const located = createPluginRegistry({
    plugins: resources.plugins,
    resources: { skills: { [external.name]: external } },
  });
  const resolver = (located.resources as unknown as {
    capabilities: { default: typeof agentCapabilities };
  }).capabilities.default;
  const resolved = resolver.resolve(
    { agent: "coordinator" },
    capabilityContext(located),
  );

  assertEquals(
    resolved.tools.map((entry) => entry.id),
    ["clock", "ask", "readToolResult"],
  );
});

Deno.test("capability selection tolerates missing unrelated callers without synthesizing one", async () => {
  const unavailableAction = defineAction({
    id: "test.capabilities.unavailable",
    execute: () => "unavailable",
  });
  const unavailable = defineTool("unavailable", unavailableAction, {
    name: "Unavailable",
    description: "Has a resource but no composed Action caller.",
  });
  const values = agents().map((item, index) =>
    index === 0 ? { ...item, capabilities: { tools: [clock.action] } } : item
  );
  const agent = values[0];
  const application = definePlugin({
    id: "test.capabilities.missing-unrelated-caller",
    version: "1.0.0",
    actions: { clock: clockAction },
    resources: {
      // Deliberately use composition aliases different from stable Agent IDs.
      agents: Object.fromEntries(
        values.map((item, index) => [`agent-alias-${index}`, item]),
      ),
      tools: { clock, unavailable },
    },
  });
  const registry = await createPluginRegistry({
    plugins: [corePlugin, application],
  });
  const resolver = registry.resources.capabilities.default;
  const resolved = resolver.resolve(
    { agent: agent.id },
    capabilityContext(registry),
  );
  assertEquals(resolved.tools.map((entry) => entry.id), [
    "clock",
    "readToolResult",
  ]);
});

Deno.test("final-root capability policies receive actual composed callers", async () => {
  let observed: readonly string[] = [];
  const policy = {
    resolve(
      input: { agent: string },
      context: Parameters<typeof agentCapabilities.resolve>[1],
    ) {
      observed = Object.keys(context.actions);
      return agentCapabilities.resolve(input, context);
    },
  };
  const resources = await registry();
  const combined = createPluginRegistry({
    plugins: resources.plugins,
    resources: { capabilities: { default: policy } },
  });
  const finalPolicy = (combined.resources as unknown as {
    capabilities: { default: typeof policy };
  }).capabilities.default;
  finalPolicy.resolve(
    { agent: "coordinator" },
    capabilityContext(combined),
  );
  assertEquals(observed, Object.keys(combined.actions));
});
