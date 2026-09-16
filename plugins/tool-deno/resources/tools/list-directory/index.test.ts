import { contribution } from "@copilotz/copilotz/plugins";
import { assertEquals } from "@std/assert";
import { listDirectoryTool } from "./index.ts";

Deno.test("list_directory Tool maps to its Action alias", () => {
  assertEquals(
    listDirectoryTool[contribution]({
      namespace: "tools",
      alias: "list_directory",
    }).value.action,
    "list_directory",
  );
});
