/** Real portable Skills entrypoint probe; caller selects its readable location. */
import { createPluginRegistry } from "@copilotz/copilotz/plugins";
import { defineSkill } from "@copilotz/copilotz/skills";
export async function readPlanningSkill(root: string | URL) {
  const registry = createPluginRegistry({
    resources: { skills: { planning: defineSkill({ root }) } },
  });
  const parsed = await registry.resources.skills.planning.load({
    scope: registry.resources,
  });
  return {
    name: parsed.manifest.name,
    body: parsed.body,
    readers: ["load_skill", "read_skill_resource"].every((alias) =>
      typeof registry.actions[alias].execute === "function"
    ),
  };
}
