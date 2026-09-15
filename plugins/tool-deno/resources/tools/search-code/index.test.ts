import { contribution } from "@copilotz/copilotz/plugins";
import { assertEquals } from "@std/assert";
import { searchCodeTool } from "./index.ts";

Deno.test("search_code Tool maps to its Action alias", () => {
  assertEquals(
    searchCodeTool[contribution]({ namespace: "tools", alias: "search_code" })
      .value.action,
    "search_code",
  );
});
