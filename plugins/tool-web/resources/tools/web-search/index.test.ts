import { contribution } from "@copilotz/copilotz/plugins";
import { assertEquals } from "@std/assert";
import { webSearchTool } from "./index.ts";

Deno.test("webSearchTool maps to the Web Search Action alias", () => {
  assertEquals(
    webSearchTool[contribution]({ namespace: "tools", alias: "web_search" })
      .value.action,
    "web_search",
  );
});
