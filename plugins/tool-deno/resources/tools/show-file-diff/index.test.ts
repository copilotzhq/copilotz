import { contribution } from "@copilotz/copilotz/plugins";
import { assertEquals } from "@std/assert";
import { showFileDiffTool } from "./index.ts";

Deno.test("show_file_diff Tool maps to its Action alias", () => {
  assertEquals(
    showFileDiffTool[contribution]({
      namespace: "tools",
      alias: "show_file_diff",
    }).value.action,
    "show_file_diff",
  );
});
