import { assertEquals } from "@std/assert";
import { definePlugin } from "@copilotz/copilotz/plugins";
import { listSkillsTool } from "./index.ts";
Deno.test("Skills tools can be selected individually", () => {
  const plugin = definePlugin({
    id: "test",
    version: "1",
    resources: { tools: { catalog: listSkillsTool } },
  });
  assertEquals(Object.keys(plugin.actions), ["catalog"]);
  assertEquals(plugin.resources.tools.catalog.action, "catalog");
});
