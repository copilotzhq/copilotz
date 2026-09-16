import { contribution } from "@copilotz/copilotz/plugins";
import { assertEquals } from "@std/assert";
import { writeFileTool } from "./index.ts";

Deno.test("write_file Tool maps to its Action alias", () => {
  assertEquals(
    writeFileTool[contribution]({ namespace: "tools", alias: "write_file" })
      .value.action,
    "write_file",
  );
});
