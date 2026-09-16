import { contribution } from "@copilotz/copilotz/plugins";
import { assertEquals } from "@std/assert";
import { searchFilesTool } from "./index.ts";

Deno.test("search_files Tool maps to its Action alias", () => {
  assertEquals(
    searchFilesTool[contribution]({ namespace: "tools", alias: "search_files" })
      .value.action,
    "search_files",
  );
});
