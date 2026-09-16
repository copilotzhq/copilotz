import { contribution } from "@copilotz/copilotz/plugins";
import { assertEquals } from "@std/assert";
import { readFileTool } from "./index.ts";

Deno.test("read_file Tool maps to its Action alias", () => {
  assertEquals(
    readFileTool[contribution]({ namespace: "tools", alias: "read_file" }).value
      .action,
    "read_file",
  );
});
