import { assertEquals } from "@std/assert";
import { definePlugin } from "@copilotz/copilotz/plugins";
import { searchKnowledgeTool } from "./index.ts";
Deno.test("Knowledge tool selection registers only the explicitly named Action", () => {
  const plugin = definePlugin({
    id: "test",
    version: "1",
    resources: { tools: { search: searchKnowledgeTool } },
  });
  assertEquals(Object.keys(plugin.actions), ["search"]);
  assertEquals(plugin.resources.tools.search.action, "search");
});
