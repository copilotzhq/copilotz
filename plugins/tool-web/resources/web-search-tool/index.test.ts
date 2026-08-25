import { assertEquals } from "@std/assert";
import { webSearchTool } from "./index.ts";

Deno.test("webSearchTool maps to the Web Search Action alias", () => {
  assertEquals(webSearchTool.action, "web_search");
});
