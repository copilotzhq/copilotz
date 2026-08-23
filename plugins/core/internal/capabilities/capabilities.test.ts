import { assertEquals, assertRejects } from "@std/assert";

import { createPluginRegistry, definePlugin } from "@copilotz/copilotz/plugins";
import { defineAction } from "@copilotz/copilotz/actions";
import type { AgentCapabilitySelection, AgentResource } from "../../agent.ts";
import {
  createSkillsPlugin,
  defineInlineSkill,
} from "@copilotz/copilotz/skills";
import { corePlugin } from "@copilotz/copilotz/core";
import { defineTool } from "@copilotz/copilotz/tools";
import { createAgentCapabilityResolver } from "./resolver.ts";
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
      createSkillsPlugin({
        id: "test.capabilities.skills",
        version: "1.0.0",
        skills: [guide],
      }),
      application,
    ],
  });
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
  const resolver = createAgentCapabilityResolver({
    registry: resources,
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
  assertEquals(resolved.tools[0].resource.action, "clock");
  assertEquals("origin" in resolved.tools[0], false);

  const restricted = await resolver.resolve({ agent: "researcher" });
  assertEquals(restricted.tools, []);
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
  const resolver = createAgentCapabilityResolver({
    registry: combined,
  });
  await assertRejects(
    () => resolver.resolve({ agent: invalid.id }),
    Error,
    "grants unknown tool 'missing'",
  );
});
