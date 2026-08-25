import { assertEquals } from "@std/assert";
import { defineTool } from "../define-tool/index.ts";
import { createToolsPlugin } from "./index.ts";

Deno.test("Tools plugin authoring maps one compound declaration", () => {
  const lookup = defineTool({
    id: "fixture.lookup",
    name: "Lookup",
    description: "Looks up a fixture.",
    execute: () => ({ ok: true }),
  });
  const plugin = createToolsPlugin({ tools: { lookup } });
  assertEquals(Object.keys(plugin.actions), ["lookup"]);
  assertEquals(plugin.resources.tools.lookup.action, "lookup");
});
