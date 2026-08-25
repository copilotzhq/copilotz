import { assertEquals } from "@std/assert";
import { fetchTextTool } from "./index.ts";

Deno.test("fetchTextTool maps to the Fetch Text Action alias", () => {
  assertEquals(fetchTextTool.action, "fetch_text");
});
