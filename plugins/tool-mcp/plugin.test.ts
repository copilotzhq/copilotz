import { assertEquals } from "@std/assert";
import { defineAction } from "@copilotz/copilotz/actions";
import { defineTool } from "@copilotz/copilotz/tools";
import { composeMcpToolsPlugin } from "./plugin.ts";

Deno.test("MCP root composes one discovered entry set", () => {
  const action = defineAction({
    id: "fixture.mcp.lookup",
    execute: () => null,
  });
  const tool = defineTool("lookup", action, {
    name: "Lookup",
    description: "Looks up a fixture.",
  });
  const plugin = composeMcpToolsPlugin({}, [{ alias: "lookup", action, tool }]);
  assertEquals(plugin.id, "@copilotz/mcp-tools");
  assertEquals(Object.keys(plugin.actions), ["lookup"]);
  assertEquals(Object.keys(plugin.resources.tools), ["lookup"]);
});
