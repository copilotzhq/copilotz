import { assertEquals, assertRejects } from "@std/assert";

import { createPluginRegistry, definePlugin } from "../plugins/index.ts";
import type { Agent, CapabilitySelection } from "../resources/index.ts";
import { createSkillsPlugin, defineInlineSkill } from "../skills/index.ts";
import { corePlugin } from "@copilotz/copilotz/plugins/core";
import {
  createWorkflowToolCatalog,
  type WorkflowTool,
} from "../tools/index.ts";
import { createAgentCapabilityResolver } from "./resolver.ts";
import { selectCapabilityResources } from "./selection.ts";

const clock: WorkflowTool = Object.freeze({
  id: "clock",
  key: "clock",
  name: "Clock",
  description: "Returns a contract time.",
  execute: () => "12:00",
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

function agents(): readonly Agent[] {
  return Object.freeze([{
    id: "coordinator",
    name: "Coordinator",
    role: "Coordinates work.",
    capabilities: {
      tools: [clock.key],
      agents: ["researcher"],
      skills: [guide.name],
    },
  }, {
    id: "researcher",
    name: "Researcher",
    role: "Researches without ambient authority.",
  }]);
}

async function registry() {
  const values = agents();
  const application = definePlugin({
    id: "test.capabilities.application",
    version: "1.0.0",
    resources: {
      agents: Object.fromEntries(values.map((agent) => [agent.id, agent])),
      tools: { [clock.key]: clock },
    },
  });
  return await createPluginRegistry({
    plugins: [
      corePlugin,
      createSkillsPlugin({
        id: "test.capabilities.skills",
        version: "1.0.0",
        skills: [guide],
      }),
      application,
    ],
  });
}

Deno.test("capability selections are least-authority and require explicit all", () => {
  const resources = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const select = (selection?: CapabilitySelection) =>
    selectCapabilityResources({
      agentId: "contract-agent",
      kind: "tool",
      selection,
      resources,
      id: (resource) => resource.id,
    }).map((resource) => resource.id);

  assertEquals(select(), []);
  assertEquals(select(["c", "a"]), ["c", "a"]);
  assertEquals(select({ all: true, except: ["b"] }), ["a", "c"]);
});

Deno.test("resolver derives ask and skill mechanisms from higher-level grants", async () => {
  const resources = await registry();
  const resolver = createAgentCapabilityResolver({
    registry: resources,
    toolCatalog: createWorkflowToolCatalog(),
  });
  const resolved = await resolver.resolve({ agent: "coordinator" });

  assertEquals(resolved.agents.map((entry) => entry.id), ["researcher"]);
  assertEquals(resolved.skills.map((entry) => entry.id), ["contract-guide"]);
  assertEquals(
    resolved.tools.map((entry) => [entry.id, entry.grant]),
    [
      ["clock", "explicit"],
      ["ask", "derived"],
      ["list_skills", "derived"],
      ["load_skill", "derived"],
      ["read_skill_resource", "derived"],
    ],
  );
  assertEquals(resolved.tools[0].resource.key, "clock");
  assertEquals("origin" in resolved.tools[0], false);

  const restricted = await resolver.resolve({ agent: "researcher" });
  assertEquals(restricted.tools, []);
  assertEquals(restricted.agents, []);
  assertEquals(restricted.skills, []);
});

Deno.test("resolver rejects unknown grants instead of silently broadening access", async () => {
  const resources = await registry();
  const invalid: Agent = {
    id: "invalid",
    name: "Invalid",
    role: "Contract fixture",
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
  const resolver = createAgentCapabilityResolver({
    registry: combined,
    toolCatalog: createWorkflowToolCatalog(),
  });
  await assertRejects(
    () => resolver.resolve({ agent: invalid.id }),
    Error,
    "grants unknown tool 'missing'",
  );
});
