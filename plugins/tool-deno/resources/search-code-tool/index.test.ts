import { assertEquals } from "@std/assert";
import { searchCodeTool } from "./index.ts";

Deno.test("search_code Tool maps to its Action alias", () => {
  assertEquals(searchCodeTool.action, "search_code");
});
