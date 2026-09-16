import { contribution } from "@copilotz/copilotz/plugins";
import { assertEquals } from "@std/assert";
import { restoreFileVersionTool } from "./index.ts";

Deno.test("restore_file_version Tool maps to its Action alias", () => {
  assertEquals(
    restoreFileVersionTool[contribution]({
      namespace: "tools",
      alias: "restore_file_version",
    }).value.action,
    "restore_file_version",
  );
});
